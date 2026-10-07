import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  verifyMetaMessagingSignature,
  parseMetaMessagingEvent,
  messagingEnvelopeSchema,
} from "./messaging-events";
import { assetCapabilities } from "./capabilities";
const app = {
  appId: "1",
  configId: "2",
  revision: 1,
  appSecret: "secret",
  apiVersion: "v22.0",
  nativeEnabled: true,
  instagramEnabled: true,
  adsEnabled: true,
};
const inbound = {
  sender: { id: "20" },
  recipient: { id: "10" },
  timestamp: 1700000000000,
  message: { mid: "m_1", text: "oi" },
};
describe("native signed messaging events", () => {
  it("accepts only the exact signed body and rejects altered or malformed signatures", () => {
    const raw = JSON.stringify(inbound);
    const signature = `sha256=${createHmac("sha256", "secret").update(raw).digest("hex")}`;
    expect(verifyMetaMessagingSignature(raw, signature, "secret")).toBe(true);
    expect(verifyMetaMessagingSignature(raw + " ", signature, "secret")).toBe(false);
    expect(verifyMetaMessagingSignature(raw, "sha256=ab", "secret")).toBe(false);
    expect(verifyMetaMessagingSignature(raw, null, "secret")).toBe(false);
  });
  it("routes inbound only to its exact entry and namespaces Meta ids", () => {
    expect(parseMetaMessagingEvent("instagram", "10", inbound)[0]).toMatchObject({
      externalId: "meta:10:m_1",
      direction: "inbound",
      participantId: "20",
      platform: "instagram",
      conversationId: "20",
    });
    expect(parseMetaMessagingEvent("instagram", "11", inbound)).toEqual([]);
  });
  it("echoes preserve outbound direction and the same id for ledger reconciliation", () => {
    expect(
      parseMetaMessagingEvent("instagram", "10", {
        ...inbound,
        sender: { id: "10" },
        recipient: { id: "20" },
        message: { ...inbound.message, is_echo: true },
      })[0],
    ).toMatchObject({
      externalId: "meta:10:m_1",
      direction: "outbound",
      status: "sent",
      participantId: "20",
    });
  });
  it("delivery updates known ids only and invalid ids do not become contacts", () => {
    expect(
      parseMetaMessagingEvent("facebook", "10", {
        ...inbound,
        message: undefined,
        delivery: { mids: ["m_1"] },
      })[0],
    ).toMatchObject({
      kind: "status",
      status: "delivered",
      externalId: "meta:10:m_1",
      direction: "outbound",
    });
    expect(
      parseMetaMessagingEvent("facebook", "10", { ...inbound, sender: { id: "not-numeric" } }),
    ).toEqual([]);
  });
  it("bounds batches and accepts Meta's page/Instagram envelope only", () => {
    expect(
      messagingEnvelopeSchema.safeParse({
        object: "instagram",
        entry: [{ id: "10", messaging: [inbound] }],
      }).success,
    ).toBe(true);
    expect(
      messagingEnvelopeSchema.safeParse({ object: "whatsapp_business_account", entry: [] }).success,
    ).toBe(false);
    expect(
      messagingEnvelopeSchema.safeParse({
        object: "page",
        entry: Array.from({ length: 101 }, () => ({ id: "10", messaging: [] })),
      }).success,
    ).toBe(false);
  });
});
describe("native messaging access requires scoped grants and tasks", () => {
  const scopes = [
    "instagram_basic",
    "instagram_manage_messages",
    "pages_manage_metadata",
    "pages_messaging",
  ];
  const base = {
    app,
    kind: "instagram" as const,
    externalId: "10",
    parentPageExternalId: "11",
    scopes,
    permissions: scopes,
    granularScopes: [],
    tasks: ["MESSAGING"],
    active: true,
  };
  it("grants Instagram Direct independently of publish/ads", () => {
    expect(assetCapabilities(base).capabilities).toMatchObject({
      instagram_message: true,
      facebook_message: false,
      instagram_publish: false,
    });
  });
  it("refuses missing messaging scope, task, revoked grant or foreign granular target", () => {
    expect(
      assetCapabilities({ ...base, scopes: ["instagram_basic", "pages_manage_metadata"] })
        .capabilities.instagram_message,
    ).toBe(false);
    expect(
      assetCapabilities({ ...base, tasks: ["CREATE_CONTENT"] }).capabilities.instagram_message,
    ).toBe(false);
    expect(
      assetCapabilities({ ...base, active: false }).capabilities.instagram_message,
    ).toBeFalsy();
    expect(
      assetCapabilities({
        ...base,
        granularScopes: [{ scope: "instagram_manage_messages", target_ids: ["99"] }],
      }).capabilities.instagram_message,
    ).toBe(false);
  });
  it("Facebook replies require page-specific permissions", () => {
    expect(assetCapabilities({ ...base, kind: "page" }).capabilities.facebook_message).toBe(true);
    expect(
      assetCapabilities({
        ...base,
        kind: "page",
        permissions: ["instagram_basic", "instagram_manage_messages", "pages_manage_metadata"],
      }).capabilities.facebook_message,
    ).toBe(false);
  });
});
