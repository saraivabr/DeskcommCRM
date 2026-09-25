import { ConnectionsClient } from "./ConnectionsClient";
import { mcpResource } from "@/lib/mcp/oauth";
export default function Page() {
  return <ConnectionsClient endpoint={mcpResource()} />;
}
