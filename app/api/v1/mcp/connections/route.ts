import { z } from "zod";
import { randomUUID } from "node:crypto";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { createConnection, hashSecret, newSecret } from "@/lib/mcp/connections";
import { authorizeInput, mcpResource } from "@/lib/mcp/oauth";
import { audit } from "@/lib/audit";
export async function GET() {
  const auth = await requireRole("viewer", { resource: "mcp_connections" });
  if (!auth.ok) return auth.response;
  if (auth.user.support)
    return fail("forbidden", "Saia do modo de suporte para gerenciar suas conexões.", 403);
  const { data, error } = await createAdminClient()
    .from("mcp_connections")
    .select("id,name,created_at,revoked_at")
    .eq("organization_id", auth.org.orgId)
    .eq("user_id", auth.user.id)
    .order("created_at", { ascending: false })
    .limit(100);
  return error
    ? fail("internal_error", "Não foi possível carregar conexões.", 500)
    : ok({ connections: data, organization: auth.org.name, role: auth.org.role });
}
export async function POST(req: Request) {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const auth = await requireRole("viewer", { resource: "mcp_connections" });
  if (!auth.ok) return auth.response;
  if (auth.user.support)
    return fail("forbidden", "Saia do modo de suporte para autorizar uma IA.", 403);
  // Consent is only accepted from the first-party session, never an MCP bearer.
  if (req.headers.get("origin") !== new URL(req.url).origin)
    return fail("forbidden", "Origem inválida.", 403);
  try {
    const input = z
      .object({
        name: z.string().trim().min(1).max(100),
        scopes: z
          .array(z.enum(["knowledge:read", "knowledge:write"]))
          .min(1)
          .max(2),
        oauth: authorizeInput.optional(),
      })
      .strict()
      .parse(await req.json());
    const db = createAdminClient();
    let clientId: string | undefined;
    if (input.oauth) {
      const oauth = input.oauth;
      const { data: client, error } = await db
        .from("mcp_oauth_clients")
        .select("id,redirect_uris")
        .eq("id", oauth.client_id)
        .maybeSingle();
      if (
        error ||
        !client ||
        !Array.isArray(client.redirect_uris) ||
        !client.redirect_uris.includes(oauth.redirect_uri) ||
        oauth.resource !== mcpResource() ||
        !input.scopes.every((scope) => oauth.scope.split(" ").includes(scope))
      )
        return fail("invalid_request", "Solicitação OAuth inválida.", 400);
      clientId = client.id;
    }
    const connection = await createConnection({
      userId: auth.user.id,
      organizationId: auth.org.orgId,
      role: auth.org.role,
      name: input.name,
      scopes: input.scopes,
      clientId,
    });
    if (input.oauth && clientId) {
      const code = newSecret();
      const oauth = input.oauth;
      const { error } = await db
        .from("mcp_oauth_grants")
        .insert({
          id: randomUUID(),
          connection_id: connection.id,
          client_id: clientId,
          kind: "code",
          secret_hash: hashSecret(code),
          challenge: oauth.code_challenge,
          redirect_uri: oauth.redirect_uri,
          resource: oauth.resource,
          expires_at: new Date(Date.now() + 300_000).toISOString(),
        });
      if (error) {
        await db
          .from("mcp_connections")
          .update({ revoked_at: new Date().toISOString() })
          .eq("id", connection.id)
          .eq("organization_id", auth.org.orgId);
        return fail("internal_error", "Não foi possível autorizar.", 500);
      }
      const redirect = new URL(oauth.redirect_uri);
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("state", oauth.state);
      return ok({ redirect: redirect.toString() }, { headers: { "Cache-Control": "no-store" } });
    }
    return ok(
      { id: connection.id, token: connection.secret },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return fail(
      "invalid_request",
      e instanceof z.ZodError
        ? "Revise as permissões solicitadas."
        : "Não foi possível criar a conexão.",
      422,
    );
  }
}
export async function DELETE(req: Request) {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const auth = await requireRole("viewer", { resource: "mcp_connections" });
  if (!auth.ok) return auth.response;
  if (auth.user.support) return fail("forbidden", "Saia do modo de suporte.", 403);
  const parsed = z.string().uuid().safeParse(new URL(req.url).searchParams.get("id"));
  if (!parsed.success) return fail("invalid_request", "Conexão inválida.", 422);
  const { data, error } = await createAdminClient()
    .from("mcp_connections")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", parsed.data)
    .eq("user_id", auth.user.id)
    .eq("organization_id", auth.org.orgId)
    .select("id")
    .maybeSingle();
  if (error || !data) return fail("not_found", "Conexão não encontrada.", 404);
  await audit({
    action: "mcp.connection_revoked",
    actorUserId: auth.user.id,
    organizationId: auth.org.orgId,
    resourceType: "mcp_connection",
    resourceId: data.id,
  });
  return ok({ revoked: true });
}
