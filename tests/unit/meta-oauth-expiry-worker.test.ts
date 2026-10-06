import { expect, it, vi } from "vitest";
import { expireMetaOAuthAttempts } from "@/workers/meta-operation-worker";
import type { MetaOperationStore } from "@/lib/channels/meta/social/operations";
it("limpa tokens de callbacks abandonados em lote limitado pela RPC canônica", async () => {
  const rpc = vi.fn().mockResolvedValue({ data: 3, error: null });
  expect(await expireMetaOAuthAttempts({ db: { rpc } } as unknown as MetaOperationStore)).toBe(3);
  expect(rpc).toHaveBeenCalledWith("fn_meta_expire_oauth", { p_limit: 200 });
});
it("não relata limpeza concluída quando o banco falha", async () => {
  const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "database unavailable" } });
  await expect(
    expireMetaOAuthAttempts({ db: { rpc } } as unknown as MetaOperationStore),
  ).rejects.toThrow("expirar autorizações");
});
it("recusa resposta malformada sem confundir resultado com contagem zero", async () => {
  const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
  await expect(
    expireMetaOAuthAttempts({ db: { rpc } } as unknown as MetaOperationStore),
  ).rejects.toThrow("expirar autorizações");
});
