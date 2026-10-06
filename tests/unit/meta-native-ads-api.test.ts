import { beforeEach, describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import type * as MetaAPI from "@/lib/channels/meta/social/api";
import type * as AdsRead from "@/lib/ads/read";
const mocks = vi.hoisted(() => ({
  role: vi.fn(),
  support: vi.fn(),
  rate: vi.fn(),
  save: vi.fn(),
  approve: vi.fn(),
  create: vi.fn(),
  accounts: vi.fn(),
  campaigns: vi.fn(),
  legacy: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: mocks.support }));
vi.mock("@/lib/auth/rate-limit", () => ({ authRateLimited: mocks.rate }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/channels/meta/social/api", async (importOriginal) => {
  const original = await importOriginal<typeof MetaAPI>();
  return { ...original, metaPublicOrigin: () => "https://local.test" };
});
vi.mock("@/lib/ads/drafts", () => ({
  adDraftContext: vi.fn(),
  saveDraft: mocks.save,
  approveDraft: mocks.approve,
  createPausedDraft: mocks.create,
}));
vi.mock("@/lib/ads/read", async (importOriginal) => {
  const { nativeCampaignQuery } = await importOriginal<typeof AdsRead>();
  return {
    nativeCampaignQuery,
    nativeAdAccounts: mocks.accounts,
    nativeCampaigns: mocks.campaigns,
  };
});
vi.mock("@/lib/plataformas-de-anuncio/credenciais-de-leitura", () => ({
  lerCredencialDeLeitura: mocks.legacy,
}));
import { GET as accounts } from "@/app/api/v1/ads/meta/accounts/route";
import { GET as campaigns } from "@/app/api/v1/ads/meta/campaigns/route";
import { POST as approve } from "@/app/api/v1/ads/meta/drafts/[id]/approve/route";
import { POST as create } from "@/app/api/v1/ads/meta/drafts/[id]/create/route";
const id = "66666666-6666-4666-8666-666666666666";
const context = { params: Promise.resolve({ id }) };
function mutation(path: string, body: unknown, origin?: string) {
  return new Request(`https://local.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.role.mockResolvedValue({
    ok: true,
    user: { id: "actor" },
    org: { orgId: "trusted-org", role: "manager" },
  });
  mocks.support.mockResolvedValue(null);
  mocks.rate.mockResolvedValue(false);
  mocks.accounts.mockResolvedValue({ source: "native", accounts: [] });
  mocks.approve.mockResolvedValue({ id, revision: 1, approved_hash: "a".repeat(64) });
  mocks.create.mockResolvedValue({ id, revision: 1, operation: { id: "safe-operation" } });
});
describe("fronteira da API Ads nativa", () => {
  it("leitura nativa não abre nem decifra credenciais legadas", async () => {
    const result = await accounts(
      new Request("https://local.test/api/v1/ads/meta/accounts?source=native"),
    );
    expect(result.status).toBe(200);
    expect(mocks.accounts).toHaveBeenCalledWith("trusted-org");
    expect(mocks.legacy).not.toHaveBeenCalled();
  });
  it("erro da conexão nativa não faz fallback para token manual", async () => {
    mocks.accounts.mockRejectedValue(new Error("revoked"));
    expect(
      (await accounts(new Request("https://local.test/api/v1/ads/meta/accounts?source=native")))
        .status,
    ).toBe(503);
    expect(mocks.legacy).not.toHaveBeenCalled();
  });
  it("não aceita ID externo onde a leitura exige asset UUID", async () => {
    const response = await campaigns(
      new NextRequest(
        `https://local.test/api/v1/ads/meta/campaigns?source=native&asset_id=act_123&connection_id=${id}&from=2026-09-01&to=2026-09-30`,
      ),
    );
    expect(response.status).toBe(422);
    expect(mocks.campaigns).not.toHaveBeenCalled();
    expect(mocks.legacy).not.toHaveBeenCalled();
  });
  it("bloqueia Origin ausente ou divergente antes de aprovar orçamento", async () => {
    for (const origin of [undefined, "https://other.test"]) {
      const response = await approve(
        mutation(
          `/api/v1/ads/meta/drafts/${id}/approve`,
          { revision: 1, review_hash: "a".repeat(64), daily_budget_cents: 3500, currency: "BRL" },
          origin,
        ),
        context,
      );
      expect(response.status).toBe(403);
    }
    expect(mocks.approve).not.toHaveBeenCalled();
  });
  it("suporte restrito não chega à reserva de operação", async () => {
    mocks.support.mockResolvedValue(new Response("restricted", { status: 403 }));
    expect(
      (
        await create(
          mutation(
            `/api/v1/ads/meta/drafts/${id}/create`,
            { revision: 1, approved_hash: "a".repeat(64) },
            "https://local.test",
          ),
          context,
        )
      ).status,
    ).toBe(403);
    expect(mocks.role).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("org e ator vêm da sessão validada e não podem ser injetados no body", async () => {
    const body = { revision: 1, approved_hash: "a".repeat(64) };
    expect(
      (
        await create(
          mutation(`/api/v1/ads/meta/drafts/${id}/create`, body, "https://local.test"),
          context,
        )
      ).status,
    ).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith("trusted-org", "actor", id, body);
    expect(
      (
        await create(
          mutation(
            `/api/v1/ads/meta/drafts/${id}/create`,
            { ...body, organization_id: "other-org" },
            "https://local.test",
          ),
          context,
        )
      ).status,
    ).toBe(400);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
});
