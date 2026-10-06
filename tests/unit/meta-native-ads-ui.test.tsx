import { beforeEach, describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), readonly: false }));
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: mocks.get, post: mocks.post, patch: mocks.patch },
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ orgId: "org-fixture" }),
  useUser: () => ({ support: mocks.readonly ? { access_mode: "support_readonly" } : undefined }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (text: string) => text }));
import { MetaNativeAdsClient } from "@/components/ads/MetaNativeAdsClient";
import { AdCampaignDrafts } from "@/components/ads/AdCampaignDrafts";
import type { NativeAdAccount, AdCampaignDraftDTO } from "@/lib/ads/types";
const account: NativeAdAccount = {
  asset_id: "33333333-3333-4333-8333-333333333333",
  connection_id: "22222222-2222-4222-8222-222222222222",
  name: "Conta escolhida",
  external_id: "12",
  currency: "BRL",
  timezone: "America/Sao_Paulo",
  capabilities: { ads_read: true, ads_manage: true, instagram_publish: false },
};
const pageId = "44444444-4444-4444-8444-444444444444",
  imageId = "55555555-5555-4555-8555-555555555555",
  draftId = "66666666-6666-4666-8666-666666666666";
const draft: AdCampaignDraftDTO = {
  id: draftId,
  revision: 2,
  status: "draft",
  connection_id: account.connection_id,
  ad_account_asset_id: account.asset_id,
  page_asset_id: pageId,
  name: "Agenda revisada",
  objective: "OUTCOME_TRAFFIC",
  destination_url: "https://example.com/agenda",
  daily_budget_cents: 3501,
  currency: "BRL",
  starts_at: "2030-01-01T12:00:00Z",
  ends_at: "2030-01-08T12:00:00Z",
  creative: { studio_item_id: imageId, message: "Conheça a agenda", title: "Agenda disponível" },
  review_hash: "a".repeat(64),
  approved_hash: null,
  operation: null,
};
function mount(component: React.ReactNode) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      {component}
    </QueryClientProvider>,
  );
}
function context() {
  return {
    data: {
      drafts: [draft],
      pages: [{ asset_id: pageId, connection_id: account.connection_id, name: "Página escolhida" }],
      images: [{ id: imageId, name: "Imagem pronta", preview_url: null }],
    },
  };
}
async function fillDraft(name = "Primeira campanha", budget = "35,01") {
  fireEvent.change(await screen.findByLabelText("Nome da campanha"), {
    target: { value: name },
  });
  fireEvent.change(screen.getByLabelText("Página do Facebook"), { target: { value: pageId } });
  fireEvent.change(screen.getByLabelText("Destino do anúncio"), {
    target: { value: draft.destination_url },
  });
  fireEvent.change(screen.getByLabelText(/Orçamento diário · BRL/), {
    target: { value: budget },
  });
  fireEvent.change(screen.getByLabelText("Imagem do Studio"), { target: { value: imageId } });
  fireEvent.change(screen.getByLabelText("Título do anúncio"), {
    target: { value: draft.creative.title },
  });
  fireEvent.change(screen.getByLabelText("Texto do anúncio"), {
    target: { value: draft.creative.message },
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.readonly = false;
  mocks.get.mockImplementation(async (url: string) =>
    url.includes("accounts")
      ? { data: { source: "native", accounts: [account] } }
      : url.endsWith(draftId)
        ? { data: draft }
        : context(),
  );
});
describe("anúncios com conexão Meta", () => {
  it("depois do primeiro salvamento edita o mesmo rascunho por PATCH com a revisão recebida", async () => {
    mocks.post.mockImplementation(async (_url, body) => ({
      data: { ...draft, id: body.id, revision: 1, name: body.name },
    }));
    mocks.patch.mockImplementation(async (_url, body) => ({
      data: { ...draft, id: body.id, revision: 2, daily_budget_cents: body.daily_budget_cents },
    }));
    mount(<AdCampaignDrafts account={account} />);
    await fillDraft();
    fireEvent.click(screen.getByRole("button", { name: "Salvar e revisar" }));
    expect(await screen.findByRole("generic", { name: "Revisão da campanha" })).toBeVisible();
    const savedId = mocks.post.mock.calls[0]?.[1].id;
    fireEvent.change(screen.getByLabelText(/Orçamento diário · BRL/), {
      target: { value: "42,02" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Salvar e revisar" }));
    await waitFor(() =>
      expect(mocks.patch).toHaveBeenCalledWith(
        `/api/v1/ads/meta/drafts/${savedId}`,
        expect.objectContaining({ id: savedId, revision: 1, daily_budget_cents: 4202 }),
      ),
    );
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });
  it("após criar a primeira campanha oferece novo rascunho com ID distinto sem reenviar a anterior", async () => {
    let current = draft;
    mocks.get.mockImplementation(async (url: string) =>
      url.endsWith(current.id) ? { data: current } : context(),
    );
    mocks.post.mockImplementation(async (url: string, body) => {
      current = url.endsWith("/approve")
        ? { ...current, status: "approved", approved_hash: current.review_hash }
        : url.endsWith("/create")
          ? {
              ...current,
              status: "submitted",
              operation: {
                id: "op-fixture",
                status: "uncertain",
                stage: "campaign_created",
                external_ids: { campaign_id: "101" },
                error_message: "Confira os IDs antes de continuar.",
              },
            }
          : { ...draft, id: body.id, revision: 1, name: body.name };
      return { data: current };
    });
    mount(<AdCampaignDrafts account={account} />);
    await fillDraft();
    fireEvent.click(screen.getByRole("button", { name: "Salvar e revisar" }));
    const review = await screen.findByRole("generic", { name: "Revisão da campanha" });
    const firstId = current.id;
    fireEvent.click(within(review).getByRole("checkbox"));
    fireEvent.click(within(review).getByRole("button", { name: "Aprovar esta revisão" }));
    fireEvent.click(await within(review).findByRole("button", { name: "Criar pausada na Meta" }));
    expect(
      await within(review).findByText("Resultado ainda não confirmado. Não crie novamente"),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Novo rascunho" }));
    expect(screen.getByLabelText("Nome da campanha")).toHaveValue("");
    expect(screen.queryByRole("generic", { name: "Revisão da campanha" })).toBeNull();
    await fillDraft("Segunda campanha", "42,02");
    fireEvent.click(screen.getByRole("button", { name: "Salvar e revisar" }));
    await waitFor(() => expect(current.name).toBe("Segunda campanha"));
    expect(current.id).not.toBe(firstId);
    expect(mocks.post.mock.calls.filter(([url]) => String(url).endsWith("/create"))).toHaveLength(
      1,
    );
    expect(mocks.patch).not.toHaveBeenCalled();
  });
  it("exige escolha e clique antes de consumir leitura Graph e envia UUIDs internos", async () => {
    mocks.get.mockImplementation(async (url: string) =>
      url.includes("accounts")
        ? { data: { source: "native", accounts: [account] } }
        : {
            data: {
              source: "native",
              asset_id: account.asset_id,
              connection_id: account.connection_id,
              currency: "BRL",
              timezone: account.timezone,
              campanhas: [],
              periodo: { from: "2026-09-01", to: "2026-09-07" },
              lido_em: "2026-09-08T12:00:00Z",
              avisos: [],
            },
          },
    );
    mount(<MetaNativeAdsClient />);
    const select = await screen.findByLabelText("Conta de anúncios");
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Consultar campanhas" })).toBeDisabled();
    fireEvent.change(select, { target: { value: `${account.connection_id}:${account.asset_id}` } });
    expect(mocks.get).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Consultar campanhas" }));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    const request = String(mocks.get.mock.calls[1]?.[0]);
    expect(request).toContain(`asset_id=${account.asset_id}`);
    expect(request).toContain(`connection_id=${account.connection_id}`);
    expect(request).not.toContain("account_id=12");
  });
  it("erro nativo pede reconexão e nunca consulta token manual como fallback", async () => {
    mocks.get.mockRejectedValue(new Error("Autorização retirada. Reconecte."));
    mount(<MetaNativeAdsClient />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Autorização retirada");
    expect(screen.getByRole("link", { name: "Conferir autorização em Conexões" })).toHaveAttribute(
      "href",
      "/app/connections?aba=sociais",
    );
    expect(mocks.get.mock.calls.every(([url]) => String(url).includes("source=native"))).toBe(true);
  });
  it("mostra ausência de conta e o próximo passo sem fabricar conexão", async () => {
    mocks.get.mockResolvedValue({ data: { source: "native", accounts: [] } });
    mount(<MetaNativeAdsClient />);
    expect(await screen.findByText("Escolha uma conta de anúncios em Conexões")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Preparar campanha" })).toBeNull();
  });
  it("aprovação exige consentimento explícito ao orçamento e usa revisão/hash exatos", async () => {
    mocks.post.mockResolvedValue({
      data: { ...draft, status: "approved", approved_hash: draft.review_hash },
    });
    mount(<AdCampaignDrafts account={account} />);
    fireEvent.click(await screen.findByRole("button", { name: "Ver revisão e resultado" }));
    const review = await screen.findByRole("generic", { name: "Revisão da campanha" });
    const approval = within(review).getByRole("button", { name: "Aprovar esta revisão" });
    expect(approval).toBeDisabled();
    fireEvent.click(within(review).getByRole("checkbox"));
    fireEvent.click(approval);
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith(`/api/v1/ads/meta/drafts/${draftId}/approve`, {
        revision: 2,
        review_hash: draft.review_hash,
        daily_budget_cents: 3501,
        currency: "BRL",
      }),
    );
    expect(await screen.findByRole("button", { name: "Criar pausada na Meta" })).toBeVisible();
  });
  it("criação incerta conserva IDs parciais e não oferece repetir criação", async () => {
    const uncertain = {
      ...draft,
      status: "submitted" as const,
      approved_hash: draft.review_hash,
      operation: {
        id: "op-fixture",
        status: "uncertain" as const,
        stage: "adset_created",
        external_ids: { campaign_id: "101" },
        error_message: "Confirme os IDs antes de continuar.",
      },
    };
    mocks.get.mockImplementation(async (url: string) =>
      url.endsWith(draftId) ? { data: uncertain } : context(),
    );
    mount(<AdCampaignDrafts account={account} />);
    fireEvent.click(await screen.findByRole("button", { name: "Ver revisão e resultado" }));
    expect(
      await screen.findByText("Resultado ainda não confirmado. Não crie novamente"),
    ).toBeVisible();
    expect(screen.getByText("101")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Criar pausada na Meta" })).toBeNull();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("suporte somente leitura mantém aprovar/criar desabilitados", async () => {
    mocks.readonly = true;
    mount(<AdCampaignDrafts account={account} />);
    fireEvent.click(await screen.findByRole("button", { name: "Ver revisão e resultado" }));
    expect(await screen.findByRole("button", { name: "Aprovar esta revisão" })).toBeDisabled();
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Salvar e revisar" })).toBeDisabled();
  });
});
