import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { hashSecret, newSecret, pkceChallenge } from "@/lib/mcp/connections";
import { mcpResource, oauthJson, oauthRateLimit } from "@/lib/mcp/oauth";
import { limitedBody } from "@/lib/knowledge/import";
export async function POST(req: Request) {
  if (!(await oauthRateLimit(req))) return oauthJson({ error: "temporarily_unavailable" }, 429);
  try {
    const body = new URLSearchParams(Buffer.from(await limitedBody(req, 16_384)).toString());
    const input = z
      .object({
        grant_type: z.enum(["authorization_code", "refresh_token"]),
        client_id: z.string().uuid(),
        code: z.string().max(256).optional(),
        refresh_token: z.string().max(256).optional(),
        code_verifier: z
          .string()
          .regex(/^[A-Za-z0-9._~-]{43,128}$/)
          .optional(),
        redirect_uri: z.string().url().optional(),
        resource: z.string().url(),
      })
      .parse(Object.fromEntries(body));
    const code = input.grant_type === "authorization_code";
    if (
      input.resource !== mcpResource() ||
      (code && (!input.code || !input.code_verifier || !input.redirect_uri)) ||
      (!code && !input.refresh_token)
    )
      return oauthJson({ error: "invalid_request" }, 400);
    const access = newSecret();
    const refresh = newSecret();
    const { data, error } = await createAdminClient().rpc("fn_mcp_exchange_grant", {
      p_hash: hashSecret((code ? input.code : input.refresh_token)!),
      p_kind: code ? "code" : "refresh",
      p_client: input.client_id,
      p_redirect: input.redirect_uri ?? null,
      p_challenge: input.code_verifier ? pkceChallenge(input.code_verifier) : null,
      p_resource: input.resource,
      p_access_hash: hashSecret(access),
      p_refresh_hash: hashSecret(refresh),
    });
    if (error) return oauthJson({ error: "invalid_grant" }, 400);
    return oauthJson({
      access_token: access,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refresh,
      scope: (data.scopes as string[])
        .filter((s) => !s.startsWith("role:") && s !== "connection:v1")
        .join(" "),
    });
  } catch {
    return oauthJson({ error: "invalid_request" }, 400);
  }
}
