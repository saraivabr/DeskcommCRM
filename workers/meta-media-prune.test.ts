import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  outerQuery: vi.fn(),
  sessionQuery: vi.fn(),
  release: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({
    query: mocks.outerQuery,
    connect: async () => ({ query: mocks.sessionQuery, release: mocks.release }),
  }),
}));
vi.mock("@/lib/channels/meta/social/bounded-admin", () => ({
  createBoundedMetaAdminClient: () => ({
    storage: { from: () => ({ remove: mocks.remove }) },
  }),
}));
vi.mock("@/lib/channels/meta/social/operations", () => ({
  MetaOperationStore: class {},
  MetaExecutionInterrupted: class extends Error {},
  createMetaExecutionContext: vi.fn(),
  resolveSelectedMetaAsset: vi.fn(),
}));
vi.mock("@/lib/channels/meta/social/publish", () => ({ executeNativeInstagramOperation: vi.fn() }));
vi.mock("@/lib/plataformas-de-anuncio/meta/native-operations", () => ({
  executeNativeAdsOperation: vi.fn(),
}));
import { pruneUnreservedMetaPublications } from "./meta-operation-worker";

const row = { organization_id: "org", id: "publication", meta_connection_id: "connection" };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.outerQuery.mockResolvedValue({ rows: [row] });
  mocks.remove.mockResolvedValue({ error: null });
  mocks.sessionQuery.mockImplementation(async ({ text }: { text: string }) => {
    if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
    if (text.includes("pg_advisory_unlock")) return { rows: [{ unlocked: true }] };
    if (text.includes("current_setting")) return { rows: [{ timeout: "0" }] };
    if (text.startsWith("select id")) return { rows: [{ id: row.id }], rowCount: 1 };
    if (text.startsWith("delete from")) return { rows: [{ id: row.id }], rowCount: 1 };
    return { rows: [] };
  });
});
describe("native preparation pruning", () => {
  it("rechecks status and upload uncertainty under exclusive ownership before deleting any copied media", async () => {
    const normal = mocks.sessionQuery.getMockImplementation()!;
    mocks.sessionQuery.mockImplementation((query) => {
      if (query.text.startsWith("select id")) {
        expect(query.text).toContain("and not meta_media_cleanup_uncertain");
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      return normal(query);
    });
    expect(await pruneUnreservedMetaPublications()).toBe(0);
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.sessionQuery.mock.calls.some(([query]) => query.text.startsWith("delete"))).toBe(
      false,
    );
  });
  it("removes only known publication copies and deletes the preparation on the locked session", async () => {
    expect(await pruneUnreservedMetaPublications()).toBe(1);
    expect(mocks.remove).toHaveBeenCalledWith(
      Array.from({ length: 10 }, (_, i) => `org/instagram/publications/publication/${i}.jpg`),
    );
    expect(mocks.outerQuery).toHaveBeenCalledTimes(1);
    expect(mocks.sessionQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringMatching(/^delete from/),
        values: ["org", "publication"],
        query_timeout: 15_000,
      }),
    );
  });
  it("retains the preparation and destroys the session when Storage removal fails", async () => {
    mocks.remove.mockResolvedValue({ error: { message: "unavailable" } });
    await expect(pruneUnreservedMetaPublications()).rejects.toMatchObject({
      code: "meta_store_unavailable",
    });
    expect(mocks.sessionQuery.mock.calls.some(([query]) => query.text.startsWith("delete"))).toBe(
      false,
    );
    expect(mocks.release).toHaveBeenCalledWith(true);
  });
});
