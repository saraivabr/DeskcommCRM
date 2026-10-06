import { createHash, createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  remove: vi.fn(),
  maybeSingle: vi.fn(),
  decrypt: vi.fn(),
  app: vi.fn(),
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  rate: vi.fn(),
}));
const chain = { select: mocks.select, eq: mocks.eq, maybeSingle: mocks.maybeSingle };
const db = {
  rpc: mocks.rpc,
  from: mocks.from,
  storage: { from: () => ({ remove: mocks.remove }) },
};
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => db }));
vi.mock("./bounded-admin", () => ({ createBoundedMetaAdminClient: () => db }));
vi.mock("@/lib/channels/meta/app", () => ({ getPlatformMetaAppPrivacy: mocks.app }));
vi.mock("@/lib/auth/rate-limit", () => ({ authRateLimited: mocks.rate }));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: mocks.decrypt }));

import {
  drainMetaPrivacyRequests,
  getMetaDeletionStatus,
  receiveMetaPrivacyRequest,
} from "./removal";

const requestId = "11111111-1111-4111-8111-111111111111";
const objectId = "22222222-2222-4222-8222-222222222222";
const orgId = "33333333-3333-4333-8333-333333333333";
const publicationId = "44444444-4444-4444-8444-444444444444";
const code = "a".repeat(64);
const object = {
  id: objectId,
  organization_id: orgId,
  publication_id: publicationId,
  index: 0,
  path: `${orgId}/instagram/publications/${publicationId}/0.jpg`,
};

function signedRequest(secret = "test-app-secret") {
  const payload = Buffer.from(
    JSON.stringify({
      algorithm: "HMAC-SHA256",
      user_id: "123456789",
      issued_at: Math.floor(Date.now() / 1000),
      expires: 0,
    }),
  ).toString("base64url");
  const proof = `${createHmac("sha256", secret).update(payload).digest("base64url")}.${payload}`;
  return new Request("https://example.test/callback", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ signed_request: proof }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.app.mockResolvedValue({ appId: "4407041089531183", appSecret: "test-app-secret" });
  mocks.rate.mockResolvedValue(false);
  mocks.decrypt.mockResolvedValue(code);
  mocks.from.mockReturnValue(chain);
  mocks.select.mockReturnValue(chain);
  mocks.eq.mockReturnValue(chain);
  mocks.remove.mockResolvedValue({ data: [], error: null });
});

describe("Meta privacy callback boundary", () => {
  it("throttles before reading or decrypting app configuration", async () => {
    mocks.rate.mockResolvedValue(true);
    await expect(receiveMetaPrivacyRequest(signedRequest(), "data_deletion")).rejects.toMatchObject(
      { status: 429 },
    );
    expect(mocks.app).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("takes app identity from the coherent configuration and subject from verified proof", async () => {
    mocks.rpc.mockResolvedValue({
      data: { request_id: requestId, confirmation_code_encrypted: "cipher", status: "pending" },
      error: null,
    });
    expect(await receiveMetaPrivacyRequest(signedRequest(), "data_deletion")).toEqual({
      confirmationCode: code,
    });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "fn_meta_privacy_request",
      expect.objectContaining({
        p_app_id: "4407041089531183",
        p_remote_actor_id: "123456789",
        p_kind: "data_deletion",
        p_confirmation_code: expect.stringMatching(/^[a-f0-9]{64}$/),
        p_request_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
  });
  it("refuses another app's signature before any removal RPC", async () => {
    await expect(
      receiveMetaPrivacyRequest(signedRequest("wrong-secret"), "deauthorization"),
    ).rejects.toThrow();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("fails closed when callback configuration is missing", async () => {
    mocks.app.mockResolvedValue(null);
    await expect(receiveMetaPrivacyRequest(signedRequest(), "data_deletion")).rejects.toThrow();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("returns the persisted replay code rather than its newly generated candidate", async () => {
    mocks.rpc.mockResolvedValue({
      data: {
        request_id: requestId,
        confirmation_code_encrypted: "persisted-cipher",
        status: "completed",
      },
      error: null,
    });
    expect(
      (await receiveMetaPrivacyRequest(signedRequest(), "data_deletion")).confirmationCode,
    ).toBe(code);
    expect(mocks.decrypt).toHaveBeenCalledWith(db, "persisted-cipher");
  });
  it("does not acknowledge a request when persistence or code decryption fails", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "500" } });
    await expect(receiveMetaPrivacyRequest(signedRequest(), "data_deletion")).rejects.toThrow();
    mocks.rpc.mockResolvedValue({
      data: { request_id: requestId, confirmation_code_encrypted: "cipher", status: "pending" },
      error: null,
    });
    mocks.decrypt.mockResolvedValue(null);
    await expect(receiveMetaPrivacyRequest(signedRequest(), "data_deletion")).rejects.toThrow();
  });
});

describe("private status lookup", () => {
  it("throttles before status database work", async () => {
    mocks.rate.mockResolvedValue(true);
    await expect(getMetaDeletionStatus(code)).rejects.toMatchObject({ status: 429 });
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it("rejects malformed codes before querying and filters valid possession proofs by hash", async () => {
    expect(await getMetaDeletionStatus("123456789")).toBeNull();
    expect(mocks.from).not.toHaveBeenCalled();
    mocks.maybeSingle.mockResolvedValue({ data: { status: "completed" }, error: null });
    expect(await getMetaDeletionStatus(code)).toBe("completed");
    expect(mocks.select).toHaveBeenCalledWith("status");
    expect(mocks.eq).toHaveBeenCalledWith(
      "confirmation_code_hash",
      createHash("sha256").update(code).digest("hex"),
    );
    expect(mocks.eq).toHaveBeenCalledWith("kind", "data_deletion");
  });
  it("returns no status for unknown code and never converts a DB error into completion", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getMetaDeletionStatus(code)).toBeNull();
    mocks.maybeSingle.mockResolvedValue({ data: null, error: { code: "500" } });
    await expect(getMetaDeletionStatus(code)).rejects.toThrow();
  });
});

describe("privacy storage outbox", () => {
  function claim() {
    mocks.rpc.mockResolvedValueOnce({
      data: { id: requestId, fence: 1, lease_until: new Date(Date.now() + 90000).toISOString() },
      error: null,
    });
  }
  it("acknowledges only successfully removed objects then persists completion", async () => {
    claim();
    mocks.rpc
      .mockResolvedValueOnce({
        data: { status: "processing", more: true, storage_objects: [object] },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { status: "completed", more: false, storage_objects: [] },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: null });
    expect(await drainMetaPrivacyRequests(db as never)).toBe(2);
    expect(mocks.remove).toHaveBeenCalledWith([object.path]);
    expect(mocks.rpc).toHaveBeenNthCalledWith(
      3,
      "fn_meta_privacy_step",
      expect.objectContaining({
        p_request_id: requestId,
        p_fence: 1,
        p_storage_object_ids: [objectId],
      }),
    );
  });
  it("retains the outbox when storage removal fails", async () => {
    claim();
    mocks.rpc.mockResolvedValueOnce({
      data: { status: "processing", more: true, storage_objects: [object] },
      error: null,
    });
    mocks.remove.mockResolvedValue({ error: { message: "temporary" } });
    await expect(drainMetaPrivacyRequests(db as never)).rejects.toThrow();
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });
  it("refuses paths outside the exact publication copy before deleting any file", async () => {
    claim();
    mocks.rpc.mockResolvedValueOnce({
      data: {
        status: "processing",
        more: true,
        storage_objects: [{ ...object, path: `${orgId}/instagram/original.jpg` }],
      },
      error: null,
    });
    await expect(drainMetaPrivacyRequests(db as never)).rejects.toThrow();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("fails on a lost fence without removing storage", async () => {
    claim();
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "PT409" } });
    await expect(drainMetaPrivacyRequests(db as never)).rejects.toThrow();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("releases this tick's work when preparation still holds its lock", async () => {
    claim();
    mocks.rpc
      .mockResolvedValueOnce({
        data: { status: "processing", more: false, storage_objects: [] },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: null });
    expect(await drainMetaPrivacyRequests(db as never)).toBe(1);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
