import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MetaExecutionContext, MetaOperationCheckpoint } from "./operations";
import {
  executeNativeInstagramOperation,
  signedPublicationMedia,
  type MetaInstagramPayload,
} from "./publish";
const ORG = "10000000-0000-4000-8000-000000000001";
const ID = "10000000-0000-4000-8000-000000000002";
const bytes = Buffer.from("owned-jpeg-bytes");
const sha = createHash("sha256").update(bytes).digest("hex");
function harness(
  format: "feed" | "carousel" | "story" = "feed",
  saved: Record<string, unknown> = {},
) {
  const payload: MetaInstagramPayload = {
    publication_id: ID,
    item_ids: [ID],
    caption: "Legenda",
    format,
    media: [{ storage_path: `${ORG}/instagram/publications/${ID}/0.jpg`, sha256: sha }],
  };
  if (format === "carousel") {
    payload.item_ids.push(ORG);
    payload.media.push({ storage_path: `${ORG}/instagram/publications/${ID}/1.jpg`, sha256: sha });
  }
  const download = vi.fn().mockResolvedValue({ data: new Blob([bytes]), error: null });
  const signed = vi.fn().mockResolvedValue({
    data: { signedUrl: "https://storage.example/tenant-owned.jpg" },
    error: null,
  });
  const request = vi.fn();
  const checkpoints: MetaOperationCheckpoint[] = [];
  const op = {
    organization_id: ORG,
    request_payload: payload,
    external_ids: { ...saved },
    status: "executing",
    stage: "reserved",
    receipt: null as Record<string, unknown> | null,
  };
  const ctx = {
    operation: op,
    resolved: { asset: { kind: "instagram", external_id: "178" }, token: "page-token" },
    db: { storage: { from: () => ({ download, createSignedUrl: signed }) } },
    graph: { request },
    read: async <T>(action: () => Promise<T>) => action(),
    checkpoint: async (input: MetaOperationCheckpoint) => {
      checkpoints.push(input);
      op.status = input.status;
      op.stage = input.stage ?? op.stage;
      Object.assign(op.external_ids, input.externalIds);
      op.receipt = input.receipt ?? op.receipt;
    },
    enrichReceipt: async (action: () => Promise<Record<string, unknown>>) => {
      try {
        Object.assign(op.receipt!, await action());
      } catch {
        /* optional enrichment preserves success */
      }
    },
    dispatch: async <T>(
      stage: string,
      action: () => Promise<T>,
      ids: (r: T) => Record<string, unknown>,
      _extraGuard?: () => Promise<void>,
      receipt?: (result: T) => Record<string, unknown>,
    ) => {
      const result = await action();
      Object.assign(op.external_ids, ids(result));
      op.stage = stage;
      if (receipt)
        await ctx.checkpoint({
          status: "succeeded",
          stage,
          receipt: receipt(result),
          externalIds: ids(result),
        });
      return result;
    },
  } as unknown as MetaExecutionContext;
  return { ctx, payload, request, checkpoints, download, signed };
}
describe("Instagram native publication", () => {
  it("creates and polls one container before publishing, then stores its real media receipt", async () => {
    const h = harness();
    h.request
      .mockResolvedValueOnce({ id: "101" })
      .mockResolvedValueOnce({ status_code: "FINISHED" })
      .mockResolvedValueOnce({ id: "202" })
      .mockResolvedValueOnce({ id: "202", permalink: "https://www.instagram.com/p/receipt/" });
    await executeNativeInstagramOperation(h.ctx);
    expect(h.request.mock.calls.map(([path]) => path)).toEqual([
      "178/media",
      "101",
      "178/media_publish",
      "202",
    ]);
    expect(h.request.mock.calls[0]?.[2]).toMatchObject({
      method: "POST",
      body: { image_url: "https://storage.example/tenant-owned.jpg", caption: "Legenda" },
    });
    expect(h.request.mock.calls[2]?.[2]).toMatchObject({ body: { creation_id: "101" } });
    expect(h.checkpoints.at(-1)).toMatchObject({
      status: "succeeded",
      receipt: { media_id: "202", permalink: "https://www.instagram.com/p/receipt/" },
    });
  });
  it("a known container resumes by read and never creates the image again", async () => {
    const h = harness("feed", { container_id: "101" });
    h.request.mockResolvedValue({ status_code: "IN_PROGRESS" });
    await executeNativeInstagramOperation(h.ctx);
    expect(h.download).not.toHaveBeenCalled();
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.checkpoints[0]).toMatchObject({
      status: "awaiting_provider",
      externalIds: { checks_101: 1 },
      retryAt: expect.any(String),
    });
  });
  it("a known published media ID resumes only its receipt read", async () => {
    const h = harness("feed", { container_id: "101", media_id: "202" });
    h.request.mockResolvedValue({ id: "202" });
    await executeNativeInstagramOperation(h.ctx);
    expect(h.request).toHaveBeenCalledWith("202", "page-token", {
      query: { fields: "id,permalink" },
    });
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.checkpoints.at(-1)).toMatchObject({
      status: "succeeded",
      receipt: { media_id: "202", permalink: null },
    });
  });
  it("authorization loss or a failed permalink read after a confirmed media ID never makes the post failed", async () => {
    const h = harness("feed", { media_id: "202" });
    h.ctx.read = vi.fn().mockRejectedValue(new Error("authorization revoked"));
    h.request.mockRejectedValue(new Error("permalink denied"));
    await executeNativeInstagramOperation(h.ctx);
    expect(h.ctx.read).not.toHaveBeenCalled();
    expect(h.checkpoints).toEqual([
      {
        status: "succeeded",
        stage: "completed",
        receipt: { media_id: "202", provider_post_id: "202", permalink: null },
      },
    ]);
    expect(h.ctx.operation.status).toBe("succeeded");
  });
  it("a PUBLISHED container without media receipt becomes uncertain with no media_publish retry", async () => {
    const h = harness("feed", { container_id: "101" });
    h.request.mockResolvedValue({ status_code: "PUBLISHED" });
    await executeNativeInstagramOperation(h.ctx);
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.checkpoints[0]?.status).toBe("uncertain");
  });
  it("polling stops after five checks and does not publish an unfinished container", async () => {
    const h = harness("feed", { container_id: "101", checks_101: 4 });
    h.request.mockResolvedValue({ status_code: "IN_PROGRESS" });
    await executeNativeInstagramOperation(h.ctx);
    expect(h.checkpoints[0]).toMatchObject({ status: "failed", externalIds: { checks_101: 5 } });
    expect(h.request).toHaveBeenCalledTimes(1);
  });
  it("carousel preserves a known child, creates only the missing child, then parents and publishes in order", async () => {
    const h = harness("carousel", { child_0: "11" });
    h.request
      .mockResolvedValueOnce({ id: "22" })
      .mockResolvedValueOnce({ status_code: "FINISHED" })
      .mockResolvedValueOnce({ status_code: "FINISHED" })
      .mockResolvedValueOnce({ id: "33" })
      .mockResolvedValueOnce({ status_code: "FINISHED" })
      .mockResolvedValueOnce({ id: "44" })
      .mockResolvedValueOnce({ id: "44" });
    await executeNativeInstagramOperation(h.ctx);
    expect(h.download).toHaveBeenCalledTimes(1);
    expect(h.request.mock.calls[3]?.[2]).toMatchObject({
      body: { media_type: "CAROUSEL", children: "11,22", caption: "Legenda" },
    });
    expect(h.checkpoints.at(-1)).toMatchObject({
      status: "succeeded",
      receipt: { media_id: "44" },
    });
  });
  it("Stories deny Creator / unknown account types before creating any container", async () => {
    const h = harness("story");
    h.request.mockResolvedValue({ account_type: "MEDIA_CREATOR" });
    await expect(executeNativeInstagramOperation(h.ctx)).rejects.toMatchObject({
      code: "meta_story_not_eligible",
    });
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.download).not.toHaveBeenCalled();
  });
  it("a proven Business Story uses media_type STORIES without a feed caption", async () => {
    const h = harness("story");
    h.request
      .mockResolvedValueOnce({ account_type: "BUSINESS" })
      .mockResolvedValueOnce({ id: "101" })
      .mockResolvedValueOnce({ status_code: "FINISHED" })
      .mockResolvedValueOnce({ id: "202" })
      .mockResolvedValueOnce({ id: "202" });
    await executeNativeInstagramOperation(h.ctx);
    expect(h.request.mock.calls[1]?.[2]).toMatchObject({ body: { media_type: "STORIES" } });
    expect(h.request.mock.calls[1]?.[2].body).not.toHaveProperty("caption");
  });
  it("foreign paths and mutated approved media never reach Graph", async () => {
    const h = harness();
    h.payload.media[0]!.storage_path = "other-tenant/image.jpg";
    await expect(signedPublicationMedia(h.ctx, h.payload, 0)).rejects.toMatchObject({
      code: "meta_media_invalid",
    });
    expect(h.download).not.toHaveBeenCalled();
    h.payload.media[0]!.storage_path = `${ORG}/instagram/publications/${ID}/0.jpg`;
    h.payload.media[0]!.sha256 = "a".repeat(64);
    await expect(signedPublicationMedia(h.ctx, h.payload, 0)).rejects.toMatchObject({
      code: "meta_media_changed",
    });
    expect(h.signed).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
  });
});
