import { afterEach, describe, expect, it, vi } from "vitest";
import { publicationResult, publishInstagram } from "./instagram-publishing";
import { publicationInput } from "@/lib/instagram/publication-schema";
import { automationMutation } from "@/lib/instagram/automation-schema";
afterEach(() => vi.unstubAllGlobals());
const id = "a3990000-0000-4000-8000-000000000001";
const account = "6a87fcba77555aae01ead8c5";
describe("Instagram publication contract", () => {
  it("does not confuse a provider draft or partial failure with publication", () => {
    expect(
      publicationResult(
        {
          post: {
            _id: "p",
            status: "draft",
            platforms: [{ accountId: account, platform: "instagram", status: "pending" }],
          },
        },
        account,
      ).status,
    ).toBe("pending");
    expect(
      publicationResult(
        {
          post: {
            _id: "p",
            status: "partial",
            platforms: [{ accountId: account, platform: "instagram", status: "failed" }],
          },
        },
        account,
      ).status,
    ).toBe("failed");
  });
  it("rejects a receipt for another account", () =>
    expect(() =>
      publicationResult(
        {
          post: {
            _id: "p",
            status: "published",
            platforms: [{ accountId: "other", platform: "instagram", status: "published" }],
          },
        },
        account,
      ),
    ).toThrow());
  it("uses one logical request ID, ordered media and Story-specific payload", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          post: {
            _id: "p",
            status: "published",
            platforms: [{ accountId: account, platform: "instagram", status: "published" }],
          },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    await publishInstagram(
      "test-secret",
      { id, account_id: account, format: "story", caption: "ignored" },
      ["https://example.test/a.jpg"],
    );
    const options = fetcher.mock.calls[0]![1];
    expect(options.headers["x-request-id"]).toBe(id);
    expect(JSON.parse(options.body)).toMatchObject({
      content: "",
      publishNow: true,
      mediaItems: [{ type: "image", url: "https://example.test/a.jpg" }],
      platforms: [{ platformSpecificData: { contentType: "story" } }],
    });
  });
  it("refuses mixed story/carousel input and duplicate assets", () => {
    expect(
      publicationInput.safeParse({
        id,
        account_id: account,
        item_ids: [id, id],
        format: "carousel",
        caption: "",
      }).success,
    ).toBe(false);
    expect(
      publicationInput.safeParse({
        id,
        account_id: account,
        item_ids: [id],
        format: "carousel",
        caption: "",
      }).success,
    ).toBe(false);
  });
  it("requires bounded keywords and a concrete post before activating", () => {
    expect(
      automationMutation.safeParse({
        action: "create",
        id,
        rule: {
          name: "A",
          account_id: account,
          post_id: "",
          keywords: ["QUERO"],
          match_mode: "contains",
          dm_response_template: "Hello",
        },
      }).success,
    ).toBe(false);
  });
});
