import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readMetaRemovalSignedRequest, verifyMetaRemovalSignature } from "./removal-signature";

const now = Date.UTC(2026, 9, 6, 20);
const secret = "test-secret-only";
const payload = {
  algorithm: "HMAC-SHA256",
  user_id: "123456789",
  issued_at: now / 1000,
  expires: 0,
};
function sign(value: unknown, key = secret) {
  const encoded = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${createHmac("sha256", key).update(encoded).digest("base64url")}.${encoded}`;
}
function request(body: string, contentType = "application/x-www-form-urlencoded") {
  return new Request("https://example.test/api/v1/integrations/meta/data-deletion", {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
}

describe("Meta removal signed_request", () => {
  it("accepts the provider's signed identity and stable receipt hash", () => {
    const proof = sign(payload);
    const result = verifyMetaRemovalSignature(proof, secret, now);
    expect(result.remoteActorId).toBe(payload.user_id);
    expect(result.issuedAt).toBe(new Date(now).toISOString());
    expect(result.signedRequestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      verifyMetaRemovalSignature(proof.replace(".", "=."), secret, now).signedRequestHash,
    ).toBe(result.signedRequestHash);
  });
  it("allows old authenticated retries, with no arbitrary freshness window", () => {
    expect(
      verifyMetaRemovalSignature(sign({ ...payload, issued_at: now / 1000 - 86400 }), secret, now)
        .remoteActorId,
    ).toBe(payload.user_id);
  });
  it.each([
    { ...payload, algorithm: "HMAC-MD5" },
    { ...payload, user_id: "../123" },
    { ...payload, user_id: 123456789 },
    { ...payload, issued_at: 0 },
    { ...payload, issued_at: now / 1000 + 301 },
    { ...payload, issued_at: "today" },
    { ...payload, expires: now / 1000 - 1 },
    { ...payload, expires: -1 },
    { ...payload, expires: "0" },
    [],
    null,
  ])("rejects invalid authenticated payload %j", (value) => {
    expect(() => verifyMetaRemovalSignature(sign(value), secret, now)).toThrow();
  });
  it("rejects altered signatures, other app secrets and appended components", () => {
    const proof = sign(payload);
    expect(() => verifyMetaRemovalSignature(proof, "other-app", now)).toThrow();
    expect(() => verifyMetaRemovalSignature(proof.slice(1), secret, now)).toThrow();
    expect(() => verifyMetaRemovalSignature(`${proof}.extra`, secret, now)).toThrow();
    expect(() => verifyMetaRemovalSignature(`!.${proof.split(".")[1]}`, secret, now)).toThrow();
    expect(() => verifyMetaRemovalSignature(proof, "", now)).toThrow();
  });
  it("accepts one form field with a charset", async () => {
    const proof = sign(payload);
    expect(
      await readMetaRemovalSignedRequest(
        request(
          new URLSearchParams({ signed_request: proof }).toString(),
          "application/x-www-form-urlencoded; charset=UTF-8",
        ),
      ),
    ).toBe(proof);
  });
  it("rejects JSON, missing and duplicate fields", async () => {
    await expect(readMetaRemovalSignedRequest(request("{}", "application/json"))).rejects.toThrow();
    await expect(readMetaRemovalSignedRequest(request("user_id=123456789"))).rejects.toThrow();
    await expect(
      readMetaRemovalSignedRequest(request("signed_request=a&signed_request=b")),
    ).rejects.toThrow();
  });
  it("bounds actual body bytes even without content-length", async () => {
    await expect(
      readMetaRemovalSignedRequest(request(`signed_request=${"x".repeat(17000)}`)),
    ).rejects.toThrow();
  });
});
