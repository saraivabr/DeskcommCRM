import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Publication } from "./publication-schema";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  download: vi.fn(),
  upload: vi.fn(),
  reserve: vi.fn(),
  resolve: vi.fn(),
  audit: vi.fn(),
  rate: vi.fn(),
  toBuffer: vi.fn(),
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({ connect: mocks.connect }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/channels/meta/social/bounded-admin", () => ({
  createBoundedMetaAdminClient: () => ({
    storage: { from: () => ({ download: mocks.download, upload: mocks.upload }) },
  }),
}));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: mocks.rate }));
vi.mock("@/lib/channels/meta/social/operations", () => ({
  MetaOperationStore: class {
    reserve = mocks.reserve;
  },
  resolveSelectedMetaAsset: mocks.resolve,
  metaOperationDTO: (operation: unknown) => operation,
}));
vi.mock("@/lib/channels/meta/social/service", () => ({ MetaNativeService: class {} }));
vi.mock("sharp", () => ({
  default: () => {
    const image = {
      rotate: () => image,
      resize: () => image,
      jpeg: () => image,
      toBuffer: mocks.toBuffer,
    };
    return image;
  },
}));
import { queueNativeInstagramPublication } from "./native-publication";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const input = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
  provider: "meta" as const,
  connection_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
  meta_asset_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5",
  item_ids: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6"],
  format: "feed" as const,
  caption: "Teste",
};
const bytes = Buffer.from("prepared image");
const target = `${ORG}/instagram/publications/${input.id}/0.jpg`;
let publication: Publication | undefined;
let stored: boolean;
let publicationOwner: object | undefined;
let events: string[];
let keys: string[];
function preparedPublication(): Publication {
  return {
    ...input,
    account_id: "123",
    meta_connection_id: input.connection_id,
    meta_media_cleanup_uncertain: false,
    requested_by: ACTOR,
    operation_id: null,
    status: "preparing",
    provider_post_id: null,
    permalink: null,
    error: null,
    created_at: "2026-10-06T00:00:00Z",
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  publication = undefined;
  stored = false;
  publicationOwner = undefined;
  events = [];
  keys = [];
  mocks.audit.mockResolvedValue(undefined);
  mocks.rate.mockResolvedValue({ allowed: true });
  mocks.resolve.mockResolvedValue({
    asset: { external_id: "123", id: input.meta_asset_id },
    connectionId: input.connection_id,
    grantId: "grant",
    authorizationVersion: 1,
  });
  mocks.toBuffer.mockResolvedValue(bytes);
  mocks.download.mockImplementation(async (path: string) =>
    path === target
      ? stored
        ? { data: new Blob([bytes]), error: null }
        : { data: null, error: { statusCode: "404" } }
      : { data: new Blob([bytes]), error: null },
  );
  mocks.upload.mockImplementation(async () => {
    events.push("upload");
    stored = true;
    return { error: null };
  });
  mocks.reserve.mockImplementation(async () => {
    events.push("reserve");
    publication!.operation_id = "operation";
    publication!.status = "sending";
    return { operation: { id: "operation", connection_id: input.connection_id } };
  });
  mocks.connect.mockImplementation(async () => {
    const owner = {};
    return {
      query: vi.fn(async ({ text, values }: { text: string; values: unknown[] }) => {
        if (text.includes("pg_try_advisory_lock_shared")) {
          keys.push(String(values[0]));
          return { rows: [{ locked: true }] };
        }
        if (text.includes("pg_try_advisory_lock")) {
          keys.push(String(values[0]));
          const locked = !publicationOwner;
          if (locked) publicationOwner = owner;
          return { rows: [{ locked }] };
        }
        if (text.includes("pg_advisory_unlock")) {
          if (String(values[0]).startsWith("meta-media-preparation:")) publicationOwner = undefined;
          return { rows: [{ unlocked: true }] };
        }
        if (text.includes("current_setting")) return { rows: [{ timeout: "0" }] };
        if (text.includes("set_config")) return { rows: [] };
        if (text.startsWith("insert into instagram_publications")) {
          publication = preparedPublication();
          events.push("attribute");
          return { rows: [publication] };
        }
        if (text.includes("from instagram_studio_items"))
          return {
            rows: input.item_ids.map((id) => ({
              id,
              asset_path: `${ORG}/instagram/source/${id}.jpg`,
              input: { format: "square" },
            })),
          };
        if (text.includes("set meta_media_cleanup_uncertain=true")) {
          if (publication!.meta_media_cleanup_uncertain) return { rows: [], rowCount: 0 };
          publication!.meta_media_cleanup_uncertain = true;
          events.push("mark");
          return { rows: [{ id: input.id }], rowCount: 1 };
        }
        if (text.includes("set meta_media_cleanup_uncertain=false")) {
          publication!.meta_media_cleanup_uncertain = false;
          events.push("confirm");
          return { rows: [{ id: input.id }], rowCount: 1 };
        }
        if (text.includes("from instagram_publications"))
          return { rows: publication ? [{ ...publication }] : [] };
        throw new Error("Unexpected fixture SQL");
      }),
      release: () => {
        if (publicationOwner === owner) publicationOwner = undefined;
      },
    };
  });
});
describe("native media preparation lifecycle", () => {
  it("persists attribution and uncertainty before upload, and reserves only after successful confirmation", async () => {
    await queueNativeInstagramPublication(ORG, ACTOR, input);
    expect(events).toEqual(["attribute", "mark", "upload", "confirm", "reserve"]);
    expect(publication!.meta_media_cleanup_uncertain).toBe(false);
  });
  it("retains the marker after an unconfirmed upload and refuses retry even when its bytes appeared", async () => {
    mocks.upload.mockImplementation(async () => {
      stored = true;
      events.push("upload");
      return { error: { message: "timeout" } };
    });
    await expect(queueNativeInstagramPublication(ORG, ACTOR, input)).rejects.toMatchObject({
      code: "meta_media_preparation_uncertain",
    });
    await expect(queueNativeInstagramPublication(ORG, ACTOR, input)).rejects.toMatchObject({
      code: "meta_media_preparation_uncertain",
    });
    expect(publication!.meta_media_cleanup_uncertain).toBe(true);
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(events).not.toContain("confirm");
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it("prevents a duplicate from reusing written bytes before the first upload reply", async () => {
    let finish!: (result: { error: null }) => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    mocks.upload.mockImplementation(async () => {
      stored = true;
      events.push("upload");
      started();
      return new Promise<{ error: null }>((resolve) => {
        finish = resolve;
      });
    });
    const first = queueNativeInstagramPublication(ORG, ACTOR, input);
    await startedPromise;
    await expect(queueNativeInstagramPublication(ORG, ACTOR, input)).rejects.toMatchObject({
      code: "meta_preparation_busy",
    });
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(publication!.meta_media_cleanup_uncertain).toBe(true);
    finish({ error: null });
    await first;
    expect(mocks.reserve).toHaveBeenCalledTimes(1);
    expect(publication!.meta_media_cleanup_uncertain).toBe(false);
  });
  it("does not upload when Storage cannot establish that the target is absent", async () => {
    mocks.download.mockImplementation(async (path: string) =>
      path === target
        ? { data: null, error: { statusCode: "503" } }
        : { data: new Blob([bytes]), error: null },
    );
    await expect(queueNativeInstagramPublication(ORG, ACTOR, input)).rejects.toMatchObject({
      code: "meta_media_unavailable",
    });
    expect(events).toEqual(["attribute"]);
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it("canonicalizes uppercase UUIDs before locks, item lookup and storage paths", async () => {
    await queueNativeInstagramPublication(ORG, ACTOR, {
      ...input,
      id: input.id.toUpperCase(),
      connection_id: input.connection_id.toUpperCase(),
      meta_asset_id: input.meta_asset_id.toUpperCase(),
      item_ids: input.item_ids.map((id) => id.toUpperCase()),
    });
    expect(keys).toEqual([
      `meta-privacy-connection:${input.connection_id}`,
      `meta-media-preparation:${ORG}:${input.id}`,
    ]);
    expect(mocks.upload).toHaveBeenCalledWith(target, bytes, expect.any(Object));
    expect(mocks.resolve).toHaveBeenCalledWith(
      ORG,
      input.meta_asset_id,
      "instagram_publish",
      input.connection_id,
      expect.any(Object),
    );
  });
  it("accepts the documented NoSuchKey error as an absent target", async () => {
    mocks.download.mockImplementation(async (path: string) =>
      path === target
        ? { data: null, error: { status: 404, statusCode: "NoSuchKey", code: "NoSuchKey" } }
        : { data: new Blob([bytes]), error: null },
    );
    await queueNativeInstagramPublication(ORG, ACTOR, input);
    expect(events).toEqual(["attribute", "mark", "upload", "confirm", "reserve"]);
  });
  it.each([401, 403, 503])(
    "never treats an HTTP%s denial/outage as an absent target",
    async (status) => {
      mocks.download.mockImplementation(async (path: string) =>
        path === target
          ? { data: null, error: { status, statusCode: "404", code: "NoSuchKey" } }
          : { data: new Blob([bytes]), error: null },
      );
      await expect(queueNativeInstagramPublication(ORG, ACTOR, input)).rejects.toMatchObject({
        code: "meta_media_unavailable",
      });
      expect(mocks.upload).not.toHaveBeenCalled();
      expect(mocks.reserve).not.toHaveBeenCalled();
    },
  );
});
