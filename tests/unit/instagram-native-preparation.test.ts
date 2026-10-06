import { beforeEach, expect, it, vi } from "vitest";
import { queueNativeInstagramPublication } from "@/lib/instagram/native-publication";
const h = vi.hoisted(() => ({
  query: vi.fn(),
  download: vi.fn(),
  upload: vi.fn(),
  reserve: vi.fn(),
  get: vi.fn(),
  resolve: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({ query: h.query }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: { from: () => ({ download: h.download, upload: h.upload }) },
  }),
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true }),
}));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/channels/meta/social/operations", () => ({
  MetaOperationStore: class {
    reserve = h.reserve;
    get = h.get;
  },
  resolveSelectedMetaAsset: h.resolve,
  metaOperationDTO: (operation: unknown) => operation,
}));
vi.mock("sharp", () => ({
  default: () => {
    const builder = {
      rotate: () => builder,
      resize: () => builder,
      jpeg: () => builder,
      toBuffer: async () => Buffer.from("prepared-jpg"),
    };
    return builder;
  },
}));
const input = {
  id: "11111111-1111-4111-8111-111111111111",
  provider: "meta" as const,
  meta_asset_id: "22222222-2222-4222-8222-222222222222",
  connection_id: "33333333-3333-4333-8333-333333333333",
  item_ids: ["44444444-4444-4444-8444-444444444444"],
  format: "feed" as const,
  caption: "Legenda",
};
let row: Record<string, unknown> | undefined;
beforeEach(() => {
  vi.resetAllMocks();
  row = undefined;
  h.resolve.mockResolvedValue({
    asset: { id: input.meta_asset_id, external_id: "1784" },
    connectionId: input.connection_id,
    grantId: "grant",
    authorizationVersion: 1,
  });
  h.download.mockResolvedValue({ data: new Blob(["source"]), error: null });
  h.upload.mockResolvedValue({ error: null });
  h.query.mockImplementation(async (sql: string) => {
    if (sql.startsWith("select") && sql.includes("from instagram_publications"))
      return { rows: row ? [row] : [] };
    if (sql.includes("from instagram_studio_items"))
      return {
        rows: [
          {
            id: input.item_ids[0],
            asset_path: "org/instagram/source.jpg",
            input: { format: "feed" },
          },
        ],
      };
    if (sql.startsWith("insert into instagram_publications")) {
      row = {
        ...input,
        account_id: "1784",
        requested_by: "actor",
        operation_id: null,
        status: "preparing",
      };
      return { rows: [row] };
    }
    if (sql.startsWith("delete from instagram_publications")) {
      if (row?.operation_id === null && row?.status === "preparing") row = undefined;
      return { rows: [] };
    }
    throw new Error("Unexpected SQL");
  });
  h.get.mockResolvedValue({
    id: "operation",
    connection_id: input.connection_id,
    status: "queued",
    receipt: null,
    error_message: null,
  });
  h.reserve.mockImplementation(async () => {
    row = { ...row, operation_id: "operation", status: "sending" };
    return { operation: { id: "operation", connection_id: input.connection_id } };
  });
});
it("falha de preparação não deixa registro bloqueando e permite repetir o mesmo id", async () => {
  h.download.mockResolvedValueOnce({ error: { message: "missing" }, data: null });
  await expect(queueNativeInstagramPublication("org", "actor", input)).rejects.toThrow(
    "preparar a imagem",
  );
  expect(row).toBeUndefined();
  expect(h.reserve).not.toHaveBeenCalled();
  await expect(queueNativeInstagramPublication("org", "actor", input)).resolves.toMatchObject({
    operation_id: "operation",
  });
});
it("erro de reserva remove somente preparação não vinculada e conserva a intenção para retry", async () => {
  h.reserve.mockRejectedValueOnce(new Error("Store unavailable"));
  await expect(queueNativeInstagramPublication("org", "actor", input)).rejects.toThrow(
    "Store unavailable",
  );
  expect(row).toBeUndefined();
  const compensation = h.query.mock.calls.find(([sql]) => sql.startsWith("delete from"));
  expect(compensation?.[0]).toContain("operation_id is null");
  expect(compensation?.[0]).toContain("status='preparing'");
  expect(compensation?.[1]).toEqual(["org", input.id, "actor"]);
  await expect(queueNativeInstagramPublication("org", "actor", input)).resolves.toMatchObject({
    operation_id: "operation",
  });
});
it("reserva commitada com resposta perdida nunca elimina o vínculo ou reenvia", async () => {
  h.reserve.mockImplementationOnce(async () => {
    row = { ...row, operation_id: "operation", status: "sending" };
    throw new Error("Response lost");
  });
  await expect(queueNativeInstagramPublication("org", "actor", input)).rejects.toThrow(
    "Response lost",
  );
  expect(row).toMatchObject({ operation_id: "operation", status: "sending" });
  await expect(queueNativeInstagramPublication("org", "actor", input)).resolves.toMatchObject({
    operation_id: "operation",
    status: "sending",
  });
  expect(h.reserve).toHaveBeenCalledTimes(1);
});
it("uma preparação antiga não vinculada também é compensada quando a autorização cai", async () => {
  row = {
    ...input,
    meta_asset_id: input.meta_asset_id,
    account_id: "1784",
    requested_by: "actor",
    operation_id: null,
    status: "preparing",
  };
  h.resolve.mockRejectedValue(new Error("Authorization revoked"));
  await expect(queueNativeInstagramPublication("org", "actor", input)).rejects.toThrow(
    "Authorization revoked",
  );
  expect(row).toBeUndefined();
  expect(h.reserve).not.toHaveBeenCalled();
});
