import { describe, expect, it } from "vitest";
import { isFirstPartyConnectionRequest } from "./connection-origin";

const publicOrigin = "https://os.escreve.ai";
const request = (origin?: string) =>
  new Request("http://escreveai-app:3000/api/v1/mcp/connections", {
    method: "POST",
    headers: origin ? { origin } : {},
  });

describe("MCP connection origin", () => {
  it("accepts the configured public origin behind a reverse proxy", () => {
    expect(isFirstPartyConnectionRequest(request(publicOrigin), publicOrigin)).toBe(true);
  });

  it("accepts the request URL origin for local installs", () => {
    expect(isFirstPartyConnectionRequest(request("http://escreveai-app:3000"), publicOrigin)).toBe(
      true,
    );
  });

  it("rejects other and missing origins", () => {
    expect(isFirstPartyConnectionRequest(request("https://evil.example"), publicOrigin)).toBe(
      false,
    );
    expect(isFirstPartyConnectionRequest(request(), publicOrigin)).toBe(false);
  });
});
