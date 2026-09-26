import { mcpResource, oauthOrigin, oauthJson } from "@/lib/mcp/oauth";
import { ACTIVE_CONNECTION_SCOPES } from "@/lib/mcp/permissions";
export async function GET() {
  return oauthJson({
    resource: mcpResource(),
    authorization_servers: [oauthOrigin()],
    scopes_supported: ACTIVE_CONNECTION_SCOPES,
    bearer_methods_supported: ["header"],
  });
}
