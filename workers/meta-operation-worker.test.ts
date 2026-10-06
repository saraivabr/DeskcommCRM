import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventRow } from "@/lib/event-log/dispatcher";
import {
  MetaExecutionInterrupted,
  type MetaOperationStore,
} from "@/lib/channels/meta/social/operations";
import { MetaIntegrationError } from "@/lib/channels/meta/social/types";
import {
  executeMetaOperation,
  handleMetaOperation,
  drainDueMetaOperations,
} from "./meta-operation-worker";
const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  resolve: vi.fn(),
  context: vi.fn(),
  checkpoint: vi.fn(),
  instagram: vi.fn(),
  ads: vi.fn(),
}));
vi.mock("@/lib/channels/meta/social/operations", () => ({
  MetaOperationStore: class {
    claim = mocks.claim;
    checkpoint = mocks.checkpoint;
  },
  MetaExecutionInterrupted: class extends Error {},
  resolveSelectedMetaAsset: mocks.resolve,
  createMetaExecutionContext: mocks.context,
}));
vi.mock("@/lib/channels/meta/social/publish", () => ({
  executeNativeInstagramOperation: mocks.instagram,
}));
vi.mock("@/lib/plataformas-de-anuncio/meta/native-operations", () => ({
  executeNativeAdsOperation: mocks.ads,
}));
const ORG = "10000000-0000-4000-8000-000000000001";
const ID = "10000000-0000-4000-8000-000000000002";
let operation: {
  id: string;
  organization_id: string;
  kind: string;
  asset_id: string;
  connection_id: string;
  status: string;
  external_ids: Record<string, unknown>;
};
beforeEach(() => {
  vi.clearAllMocks();
  operation = {
    id: ID,
    organization_id: ORG,
    kind: "instagram_publish",
    asset_id: ID,
    connection_id: ID,
    status: "executing",
    external_ids: {},
  };
  mocks.claim.mockResolvedValue(operation);
  mocks.resolve.mockResolvedValue({});
  mocks.context.mockReturnValue({ operation, checkpoint: mocks.checkpoint });
  mocks.instagram.mockResolvedValue(undefined);
  mocks.ads.mockResolvedValue(undefined);
  mocks.checkpoint.mockResolvedValue(undefined);
});
describe("durable native worker", () => {
  it("requires an acquired tenant-scoped claim and never dispatches after a lost lease", async () => {
    mocks.claim.mockResolvedValue(null);
    await executeMetaOperation(ORG, ID);
    expect(mocks.claim).toHaveBeenCalledWith(ORG, ID, expect.stringMatching(/^meta:/));
    expect(mocks.instagram).not.toHaveBeenCalled();
  });
  it("keeps Instagram and Ads execution bound to their immutable provider intent", async () => {
    await executeMetaOperation(ORG, ID);
    expect(mocks.instagram).toHaveBeenCalledTimes(1);
    expect(mocks.ads).not.toHaveBeenCalled();
    operation.kind = "ads_create";
    await executeMetaOperation(ORG, ID);
    expect(mocks.ads).toHaveBeenCalledTimes(1);
  });
  it("an interrupted dispatch never enters the generic retry path", async () => {
    mocks.instagram.mockRejectedValue(new MetaExecutionInterrupted("uncertain"));
    await executeMetaOperation(ORG, ID);
    expect(mocks.checkpoint).not.toHaveBeenCalled();
  });
  it("a read-only provider outage resumes the known container later without losing its ID", async () => {
    operation.external_ids = { container_id: "123" };
    mocks.instagram.mockRejectedValue(
      new MetaIntegrationError("meta_provider_unavailable", "Temporariamente indisponível.", 502),
    );
    await executeMetaOperation(ORG, ID);
    expect(mocks.checkpoint).toHaveBeenCalledWith(
      operation,
      expect.objectContaining({
        status: "awaiting_provider",
        externalIds: { read_failures: 1 },
        retryAt: expect.any(String),
      }),
    );
    expect(operation.external_ids.container_id).toBe("123");
  });
  it("invalid event pointers cannot invoke a claim in another tenant", async () => {
    const row = {
      organization_id: ORG,
      entity_id: ID,
      entity_kind: "meta_operation",
      payload: { operation_id: "another" },
    } as unknown as EventRow;
    expect((await handleMetaOperation(row)).status).toBe("skipped");
    expect(mocks.claim).not.toHaveBeenCalled();
  });
  it("the recurring drain resumes due containers and expired leases independently of consumed events", async () => {
    const query = {
      select: vi.fn(),
      or: vi.fn(),
      order: vi.fn(),
      limit: vi.fn().mockResolvedValue({ data: [{ id: ID, organization_id: ORG }], error: null }),
    };
    query.select.mockReturnValue(query);
    query.or.mockReturnValue(query);
    query.order.mockReturnValue(query);
    const store = {
      db: { from: vi.fn(() => query) },
      claim: mocks.claim,
      checkpoint: mocks.checkpoint,
    } as unknown as MetaOperationStore;
    expect(await drainDueMetaOperations(store)).toBe(1);
    expect(query.or.mock.calls[0]?.[0]).toContain("awaiting_provider");
    expect(query.or.mock.calls[0]?.[0]).toContain("lease_until.lte.");
    expect(mocks.instagram).toHaveBeenCalledTimes(1);
  });
});
