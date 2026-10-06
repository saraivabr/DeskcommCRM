import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ receive: vi.fn(), role: vi.fn() }));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://produto.example" } }));
vi.mock("@/lib/channels/meta/social/removal", () => ({ receiveMetaPrivacyRequest: mocks.receive }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.role }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));
import { MetaIntegrationError } from "@/lib/channels/meta/social/types";
import { POST as deletion } from "./data-deletion/route";
import { POST as deauthorization } from "./deauthorization/route";

const code = "a".repeat(64);
function request() {
  return new Request("https://attacker.example/api/v1/integrations/meta/data-deletion", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "signed_request=test-proof",
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.receive.mockResolvedValue({ confirmationCode: code });
});

describe("Meta provider privacy protocol", () => {
  it("returns the provider's root contract with our canonical origin, without browser authentication", async () => {
    const req = request();
    const response = await deletion(req);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      url: `https://produto.example/legal/meta-data-deletion/status?code=${code}`,
      confirmation_code: code,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(mocks.receive).toHaveBeenCalledWith(req, "data_deletion");
    expect(mocks.role).not.toHaveBeenCalled();
  });
  it("acknowledges deauthorization only after durable acceptance", async () => {
    const req = request();
    const response = await deauthorization(req);
    expect(await response.json()).toEqual({ success: true });
    expect(mocks.receive).toHaveBeenCalledWith(req, "deauthorization");
  });
  it("rejects an invalid signature and keeps the status code", async () => {
    mocks.receive.mockRejectedValue(
      new MetaIntegrationError("meta_callback_invalid", "Solicitação inválida.", 401),
    );
    const response = await deletion(request());
    expect(response.status).toBe(401);
    expect(await response.json()).not.toHaveProperty("confirmation_code");
  });
  it("never acknowledges a persistence failure", async () => {
    mocks.receive.mockRejectedValue(new Error("private database failure"));
    const response = await deauthorization(request());
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).not.toContain("private database failure");
    expect(body).not.toContain('"success":true');
  });
});
