import { describe, it, expect, vi } from "vitest";
import type { MetaGraphClient } from "@/lib/channels/meta/social/graph";
import { nativeCollection, readNativeCampaigns } from "./native-insights";
import { z } from "zod";
describe("leitura de anúncios nativos", () => {
  it("pede campanhas e métricas da conta resolvida, com datas e campos de resultado", async () => {
    const request = vi.fn().mockResolvedValue({ data: [] });
    await readNativeCampaigns(
      { request } as unknown as MetaGraphClient,
      "token-fixture",
      "123",
      "2026-09-01",
      "2026-09-30",
    );
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[0]).toBe("act_123/campaigns");
    expect(request.mock.calls[1]?.[0]).toBe("act_123/insights");
    expect(request.mock.calls[1]?.[2].query.time_range).toBe(
      JSON.stringify({ since: "2026-09-01", until: "2026-09-30" }),
    );
    expect(request.mock.calls[1]?.[2].query.fields).toContain("inline_link_clicks");
  });
  it("usa somente cursor no mesmo path mesmo quando paging.next contém outro host", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ id: "1" }],
        paging: { next: "https://evil.invalid/steal", cursors: { after: "cursor-2" } },
      })
      .mockResolvedValueOnce({ data: [{ id: "2" }] });
    const result = await nativeCollection(
      { request } as unknown as MetaGraphClient,
      "act_123/campaigns",
      "token-fixture",
      {},
      z.object({ id: z.string() }),
    );
    expect(result).toEqual([{ id: "1" }, { id: "2" }]);
    expect(request.mock.calls[1]?.[0]).toBe("act_123/campaigns");
    expect(request.mock.calls[1]?.[2].query.after).toBe("cursor-2");
  });
  it("fecha uma paginação incompleta em vez de mostrar uma soma parcial", async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ data: [], paging: { next: "next", cursors: { after: "same" } } });
    await expect(
      nativeCollection(
        { request } as unknown as MetaGraphClient,
        "act_123/campaigns",
        "fixture",
        {},
        z.unknown(),
      ),
    ).rejects.toMatchObject({ code: "meta_inventory_incomplete" });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("não converte falha de permissão em dados vazios", async () => {
    const request = vi.fn().mockRejectedValue(new Error("permission revoked"));
    await expect(
      readNativeCampaigns(
        { request } as unknown as MetaGraphClient,
        "fixture",
        "123",
        "2026-09-01",
        "2026-09-30",
      ),
    ).rejects.toThrow("permission revoked");
  });
});
