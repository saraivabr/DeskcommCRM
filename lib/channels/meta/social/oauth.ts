import { createHash, randomBytes } from "node:crypto";
import { MetaIntegrationError, type MetaNativeApp } from "./types";

export const META_CALLBACK_PATH = "/api/v1/integrations/meta/callback";
export const META_OAUTH_COOKIE = "meta_native_oauth";
export const META_OAUTH_TTL_SECONDS = 600;
export const metaOpaquePattern = /^[A-Za-z0-9_-]{43}$/;
export function opaqueNonce(): string {
  return randomBytes(32).toString("base64url");
}
export function hashOpaque(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function metaAppConfigured(app: MetaNativeApp): boolean {
  return (
    app.nativeEnabled &&
    Boolean(
      app.appId &&
      /^\d+$/.test(app.appId) &&
      app.configId &&
      /^\d+$/.test(app.configId) &&
      app.appSecret &&
      /^v\d+\.\d+$/.test(app.apiVersion),
    )
  );
}

export function montarMetaAuthorizationUrl(
  app: MetaNativeApp,
  origin: string,
  state: string,
): string {
  if (!metaAppConfigured(app))
    throw new MetaIntegrationError(
      "meta_not_configured",
      "O login Meta ainda não está configurado nesta instalação.",
      503,
    );
  const url = new URL(`https://www.facebook.com/${app.apiVersion}/dialog/oauth`);
  url.search = new URLSearchParams({
    client_id: app.appId!,
    config_id: app.configId!,
    redirect_uri: new URL(META_CALLBACK_PATH, origin).toString(),
    response_type: "code",
    override_default_response_type: "true",
    state,
  }).toString();
  return url.toString();
}

/** A origem pública configurada é a autoridade, nunca Host encaminhado livre. */
export function sameOriginMutation(request: Request, publicOrigin: string): boolean {
  const origin = request.headers.get("origin");
  if (!origin || request.headers.get("sec-fetch-site") === "cross-site") return false;
  try {
    return (
      new URL(origin).origin === new URL(publicOrigin).origin && origin === new URL(origin).origin
    );
  } catch {
    return false;
  }
}

export type MetaCallbackError = "cancelled" | "invalid_state" | "config_changed" | "provider_error";
export function metaCallbackDestination(
  result: { ticket: string } | { error: MetaCallbackError },
): string {
  const query = new URLSearchParams({ aba: "sociais" });
  if ("ticket" in result) query.set("meta_ticket", result.ticket);
  else query.set("meta_error", result.error);
  return `/app/connections?${query.toString()}`;
}

/** Página same-origin: o GET externo só confirma state; sessão Strict volta nesta navegação. */
export function metaBridgeHTML(destination: string, nonce: string): string {
  const safeDestination = JSON.stringify(destination).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Conexão Meta</title><body><p>Voltando para suas conexões…</p><script nonce="${nonce}">location.replace(${safeDestination})</script></body></html>`;
}
