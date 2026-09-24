import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { mfaEmDivida } from "@/lib/auth/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { socialRequest, SocialError } from "@/lib/channels/social/client";
import {
  instagramContext,
  instagramAutomations,
  instagramPosts,
  requireInstagramAccount,
  socialId,
  automationLogSchema,
} from "@/lib/channels/social/instagram-management";
import { automationMutation } from "@/lib/instagram/automation-schema";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
function failure(error: unknown, requestId: string) {
  return fail(
    "instagram_unavailable",
    error instanceof SocialError
      ? error.message
      : "Não foi possível consultar ou salvar a automação. Atualize a lista antes de tentar novamente.",
    error instanceof SocialError ? error.status : 502,
    { requestId, headers },
  );
}
export async function GET(req: Request) {
  const requestId = randomUUID();
  const auth = await requireRole("viewer", { requestId });
  if (!auth.ok) return auth.response;
  const query = z
    .object({ account_id: socialId.optional(), logs: socialId.optional() })
    .strict()
    .safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!query.success) return fail("validation_failed", "Consulta inválida.", 400, { requestId });
  try {
    const context = await instagramContext(createAdminClient(), auth.org.orgId);
    if (query.data.account_id) {
      requireInstagramAccount(context, query.data.account_id);
      return ok(
        { posts: await instagramPosts(context.key, query.data.account_id) },
        { requestId, headers },
      );
    }
    const automations = await instagramAutomations(context);
    if (query.data.logs) {
      if (!automations.some((a) => a.id === query.data.logs))
        throw new SocialError("Automação não encontrada nesta organização.", 404);
      const logs = z
        .object({ logs: z.array(automationLogSchema) })
        .parse(
          await socialRequest(context.key, `comment-automations/${query.data.logs}/logs?limit=50`),
        );
      return ok(logs, { requestId, headers });
    }
    return ok(
      {
        automations,
        accounts: context.accounts.map((a) => ({
          id: a._id,
          username: a.username ?? a.displayName ?? a._id,
          active: a.isActive,
        })),
        can_edit: ["manager", "admin"].includes(auth.org.role),
      },
      { requestId, headers },
    );
  } catch (error) {
    return failure(error, requestId);
  }
}
export async function POST(req: Request) {
  const requestId = randomUUID();
  const support = await requireSupportWrite();
  if (support) return support;
  const auth = await requireRole("manager", { requestId });
  if (!auth.ok) return auth.response;
  if (await mfaEmDivida())
    return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });
  const parsed = automationMutation.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return fail("validation_failed", "Confira a postagem, as palavras-chave e a mensagem.", 400, {
      requestId,
    });
  const limit = await checkRateLimit(`instagram-automation:${auth.org.orgId}`, 30, 60);
  if (!limit.allowed)
    return fail("rate_limited", "Aguarde um minuto.", 429, {
      requestId,
      headers: { "Retry-After": "60" },
    });
  try {
    const body = parsed.data;
    const context = await instagramContext(createAdminClient(), auth.org.orgId);
    const automations = await instagramAutomations(context);
    const existing =
      body.action !== "create" ? automations.find((a) => a.id === body.id) : undefined;
    if (body.action !== "create" && !existing)
      throw new SocialError("Automação não encontrada nesta organização.", 404);
    let result: unknown;
    if (body.action === "toggle") {
      requireInstagramAccount(context, existing!.accountId);
      result = await socialRequest(
        context.key,
        `comment-automations/${body.id}`,
        { isActive: body.is_active },
        { method: "PATCH" },
      );
    } else {
      const rule = body.rule;
      requireInstagramAccount(context, rule.account_id);
      if (
        existing &&
        (existing.accountId !== rule.account_id || (existing.platformPostId ?? "") !== rule.post_id)
      )
        throw new SocialError("Crie outra regra para mudar a conta ou postagem.", 422);
      const posts = await instagramPosts(context.key, rule.account_id);
      const post = posts.find((p) => p.id === rule.post_id);
      if (!post && !existing) throw new SocialError("Selecione uma postagem desta conta.", 422);
      const fields = {
        name: rule.name,
        keywords: rule.keywords,
        matchMode: rule.match_mode,
        dmMessage: rule.dm_response_template,
        commentReply: rule.comment_reply,
      };
      if (body.action === "create") {
        // Provider guarantees one active per-post rule. Reconcile uncertain creates before repeating.
        const samePost = automations.find(
          (a) => a.accountId === rule.account_id && a.platformPostId === rule.post_id && a.isActive,
        );
        if (samePost) {
          if (
            samePost.name === rule.name &&
            samePost.dmMessage === rule.dm_response_template &&
            samePost.matchMode === rule.match_mode &&
            JSON.stringify(samePost.keywords) === JSON.stringify(rule.keywords) &&
            (samePost.commentReply ?? "") === rule.comment_reply
          )
            return ok({ automation: samePost }, { requestId, headers });
          throw new SocialError(
            "Esta postagem já tem uma regra ativa. Edite a regra existente.",
            409,
          );
        }
        result = await socialRequest(
          context.key,
          "comment-automations",
          {
            ...fields,
            profileId: context.profileId,
            accountId: rule.account_id,
            platformPostId: rule.post_id,
            postTitle: post?.message.slice(0, 120),
          },
          { requestId: body.id },
        );
      } else
        result = await socialRequest(context.key, `comment-automations/${body.id}`, fields, {
          method: "PATCH",
        });
    }
    void audit({
      action: "channel.social_configured",
      organizationId: auth.org.orgId,
      actorUserId: auth.user.id,
      resourceType: "instagram_automation",
      requestId,
      metadata: { operation: body.action, automation_id: body.id },
    });
    // Do not expose unvalidated provider response fields (which may grow to contain secrets).
    z.object({ success: z.boolean() }).parse(result);
    return ok({ saved: true }, { requestId, headers });
  } catch (error) {
    return failure(error, requestId);
  }
}
