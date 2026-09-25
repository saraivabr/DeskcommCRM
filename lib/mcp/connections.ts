import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { ROLE_RANK, type Role } from "@/lib/auth/types";
import { validConnectionScopes } from "./permissions";
import { audit } from "@/lib/audit";

export const hashSecret = (value: string) => createHash("sha256").update(value).digest("hex");
export const newSecret = () => `dsk_${randomBytes(32).toString("base64url")}`;
export const pkceChallenge = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");

export async function createConnection(input: {
  userId: string;
  organizationId: string;
  role: Role;
  name: string;
  scopes: string[];
  clientId?: string;
}) {
  if (!validConnectionScopes(input.scopes, input.role))
    throw new Error("Permissões inválidas para este usuário.");
  const db = createAdminClient();
  const id = randomUUID();
  const secret = newSecret();
  const scopes = [...new Set([...input.scopes, "connection:v1", `role:${input.role}`])];
  const { error } = await db.from("api_tokens").insert({
    id,
    organization_id: input.organizationId,
    created_by: input.userId,
    name: input.name,
    prefix: secret.slice(0, 12),
    token_hash: `\\x${hashSecret(secret)}`,
    scopes,
    expires_at: new Date(Date.now() + (input.clientId ? 300_000 : 90 * 86_400_000)).toISOString(),
  });
  if (error) throw new Error("Não foi possível criar a conexão.");
  const { error: connectionError } = await db.from("mcp_connections").insert({
    id,
    organization_id: input.organizationId,
    user_id: input.userId,
    name: input.name,
    client_id: input.clientId ?? null,
  });
  if (connectionError) {
    await db
      .from("api_tokens")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", id)
      .eq("organization_id", input.organizationId);
    throw new Error("Não foi possível criar a conexão.");
  }
  void audit({
    action: "mcp.connection_created",
    actorUserId: input.userId,
    organizationId: input.organizationId,
    resourceType: "mcp_connection",
    resourceId: id,
    metadata: { scopes: input.scopes },
  });
  return { id, secret, scopes };
}

/** Live membership is authoritative, never the role written into an old token. */
export async function resolveConnection(
  tokenId: string,
  organizationId: string,
  grantedRole: Role,
) {
  const db = createAdminClient();
  const { data: connection, error } = await db
    .from("mcp_connections")
    .select("id,user_id,revoked_at")
    .eq("id", tokenId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error || !connection || connection.revoked_at)
    throw new Error("Conexão revogada ou indisponível.");
  const { data: member, error: membershipError } = await db
    .from("user_organizations")
    .select("role")
    .eq("organization_id", organizationId)
    .eq("user_id", connection.user_id)
    .maybeSingle();
  if (membershipError || !member || !(member.role in ROLE_RANK))
    throw new Error("O usuário não tem mais acesso à organização.");
  const { data: organization, error: organizationError } = await db
    .from("organizations")
    .select("status")
    .eq("id", organizationId)
    .maybeSingle();
  if (organizationError || !organization || organization.status === "suspended")
    throw new Error("Organização indisponível.");
  const role =
    ROLE_RANK[member.role as Role] < ROLE_RANK[grantedRole] ? (member.role as Role) : grantedRole;
  return { connectionId: connection.id as string, userId: connection.user_id as string, role };
}
