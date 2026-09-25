import { audit } from "@/lib/audit";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { hashSecret } from "@/lib/mcp/connections";
import { oauthJson, oauthRateLimit } from "@/lib/mcp/oauth";
import { limitedBody } from "@/lib/knowledge/import";
export async function POST(req: Request) {
  if (!(await oauthRateLimit(req))) return oauthJson({ error: "temporarily_unavailable" }, 429);
  try {
    const input = z
      .object({ token: z.string().min(1).max(256), client_id: z.string().uuid() })
      .parse(
        Object.fromEntries(
          new URLSearchParams(Buffer.from(await limitedBody(req, 4096)).toString()),
        ),
      );
    const db = createAdminClient();
    const hash = hashSecret(input.token);
    const { data: grant } = await db
      .from("mcp_oauth_grants")
      .select("connection_id")
      .eq("secret_hash", hash)
      .eq("client_id", input.client_id)
      .maybeSingle();
    let id = grant?.connection_id;
    if (!id) {
      const { data: token } = await db
        .from("api_tokens")
        .select("id")
        .eq("token_hash", `\\x${hash}`)
        .maybeSingle();
      id = token?.id;
    }
    if (id) {
      const { data: c } = await db
        .from("mcp_connections")
        .select("id,organization_id,user_id")
        .eq("id", id)
        .eq("client_id", input.client_id)
        .maybeSingle();
      if (c) {
        const { error } = await db
          .from("mcp_connections")
          .update({ revoked_at: new Date().toISOString() })
          .eq("id", c.id)
          .eq("organization_id", c.organization_id);
        if (error) return oauthJson({ error: "server_error" }, 503);
        await audit({
          action: "mcp.connection_revoked",
          organizationId: c.organization_id,
          actorUserId: c.user_id,
          resourceType: "mcp_connection",
          resourceId: c.id,
        });
      }
    }
    return oauthJson({});
  } catch {
    return oauthJson({ error: "invalid_request" }, 400);
  }
}
