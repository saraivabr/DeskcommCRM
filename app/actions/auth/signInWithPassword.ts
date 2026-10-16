"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { safeNext } from "@/lib/auth/safe-next";

import { createClient } from "@/lib/supabase/server";
import { loginSchema, type LoginInput } from "@/lib/auth/schemas";
import { audit, hashEmail } from "@/lib/audit";
import { isAuthUnavailable, withAuthDeadline } from "@/lib/auth/availability";
import {
  authRateLimited,
  contaBloqueadaPorFalhas,
  registrarFalhaDeLogin,
  AUTH_LIMITS,
} from "@/lib/auth/rate-limit";

export type SignInResult = {
  ok: false;
  error: "invalid_credentials" | "rate_limited" | "validation_error" | "mfa_required" | "auth_unavailable";
  details?: Record<string, unknown>;
  challengeId?: string;
};

/**
 * Sign in with password.
 *
 * On success: redirects server-side to `next` (or /app/inbox / /onboarding/mfa).
 * The redirect ensures Set-Cookie headers from supabase.auth propagate before
 * middleware re-evaluates the session — fixes Next 15 Server Action cookie
 * propagation race.
 *
 * On failure: returns an error discriminator. Caller renders inline message.
 */
export async function signInWithPassword(input: LoginInput, next?: string): Promise<SignInResult> {
  const parsed = loginSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "validation_error",
      details: parsed.error.flatten().fieldErrors,
    };
  }

  const supabase = await createClient();
  const hdrs = await headers();
  const requestId = hdrs.get("x-request-id");
  const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = hdrs.get("user-agent") ?? null;

  // Antes de falar com o GoTrue: sem isto, tentar senha era de graça e
  // ilimitado (issue #64). Conta por IP e por conta — o ataque distribuído
  // contra um e-mail só não aparece na contagem por IP.
  if (
    (await authRateLimited("login", null, AUTH_LIMITS.login)) ||
    (await contaBloqueadaPorFalhas(parsed.data.email, AUTH_LIMITS.login))
  ) {
    await audit({
      action: "auth.login_rate_limited",
      metadata: { email_hash: hashEmail(parsed.data.email) },
      requestId,
      ip,
      userAgent,
    });
    return { ok: false, error: "rate_limited" };
  }

  let result;
  try {
    result = await withAuthDeadline(() => supabase.auth.signInWithPassword({
      email: parsed.data.email,
      password: parsed.data.password,
    }));
  } catch {
    return { ok: false, error: "auth_unavailable" };
  }
  const { data, error } = result;
  if (error?.status === 429) return { ok: false, error: "rate_limited" };
  // Timeout/503 não é senha errada e não pode bloquear a conta por tentativas.
  if (isAuthUnavailable(error)) return { ok: false, error: "auth_unavailable" };

  if (error || !data.user) {
    // Só senha errada gasta o orçamento da conta.
    await registrarFalhaDeLogin(parsed.data.email, AUTH_LIMITS.login);
    await audit({
      action: "auth.login_failed",
      metadata: {
        email_hash: hashEmail(parsed.data.email),
        reason: error?.message ?? "unknown",
      },
      requestId,
      ip,
      userAgent,
    });
    return { ok: false, error: "invalid_credentials" };
  }

  // MFA gating — if the user has any verified TOTP factor enrolled, they must
  // complete the challenge in /login/mfa before reaching the app.
  let factors;
  try {
    factors = await withAuthDeadline(() => supabase.auth.mfa.listFactors());
  } catch {
    return { ok: false, error: "auth_unavailable" };
  }
  const { data: factorsData, error: factorsError } = factors;
  if (factorsError || !factorsData) return { ok: false, error: "auth_unavailable" };
  const verifiedTotp = factorsData?.totp?.find((f) => f.status === "verified");
  if (verifiedTotp) {
    return { ok: false, error: "mfa_required", challengeId: verifiedTotp.id };
  }

  await audit({
    action: "auth.login_success",
    actorUserId: data.user.id,
    metadata: {},
    requestId,
    ip,
    userAgent,
  });

  // Server-side redirect ensures fresh session cookie is sent to browser.
  redirect(safeNext(next, "/app"));
}
