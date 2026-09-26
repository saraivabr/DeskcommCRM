import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { oauthJson, oauthRateLimit, validRedirect } from "@/lib/mcp/oauth";
import { limitedBody } from "@/lib/knowledge/import";
export async function POST(req: Request) {
  if (!(await oauthRateLimit(req))) return oauthJson({ error: "temporarily_unavailable" }, 429);
  try {
    const raw = JSON.parse(Buffer.from(await limitedBody(req, 16_384)).toString());
    const input = z
      .object({
        client_name: z.string().trim().min(1).max(120).default("Minha IA"),
        redirect_uris: z.array(z.string().url().max(2048).refine(validRedirect)).min(1).max(10),
        token_endpoint_auth_method: z.literal("none").default("none"),
      })
      .parse(raw);
    const { data, error } = await createAdminClient()
      .from("mcp_oauth_clients")
      .insert({ name: input.client_name, redirect_uris: input.redirect_uris })
      .select("id")
      .single();
    if (error) return oauthJson({ error: "server_error" }, 503);
    return oauthJson(
      {
        client_id: data.id,
        client_name: input.client_name,
        redirect_uris: input.redirect_uris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      201,
    );
  } catch {
    return oauthJson({ error: "invalid_client_metadata" }, 400);
  }
}
