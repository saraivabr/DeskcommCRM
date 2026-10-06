import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { MetaNativeClient } from "@/components/connections/MetaNativeClient";
import { AdCampaignDrafts } from "@/components/ads/AdCampaignDrafts";
import type { AdCampaignDraftDTO, NativeAdAccount } from "@/lib/ads/types";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: mocks.get } }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ orgId: "org-fixture" }),
  useUser: () => ({}),
}));

const account: NativeAdAccount = {
  asset_id: "33333333-3333-4333-8333-333333333333",
  connection_id: "22222222-2222-4222-8222-222222222222",
  name: "Conta da empresa",
  external_id: "12",
  currency: "BRL",
  timezone: "America/Sao_Paulo",
  capabilities: { ads_read: true, ads_manage: true, instagram_publish: false },
};
function mount(component: React.ReactNode) {
  render(
    <IdiomaProvider locale="es">
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        {component}
      </QueryClientProvider>
    </IdiomaProvider>,
  );
}
beforeEach(() => vi.clearAllMocks());

it("a conexão traduz o estado e formata a data em espanhol preservando o nome cadastrado", async () => {
  const checkedAt = "2026-10-05T13:30:00Z";
  mocks.get.mockResolvedValue({
    data: {
      configured: true,
      capabilities: account.capabilities,
      connections: [
        {
          id: account.connection_id,
          actor_name: account.name,
          status: "healthy",
          selected_asset_count: 1,
          reconnect_required: false,
          checked_at: checkedAt,
          expires_at: "2026-11-05T00:00:00Z",
          scopes: ["ads_read"],
        },
      ],
    },
  });
  mount(<MetaNativeClient />);
  expect(await screen.findByText("Autorización válida")).toBeVisible();
  expect(screen.getByText("Tu Instagram y tus anuncios, aquí")).toBeVisible();
  expect(screen.getByText(account.name)).toBeVisible();
  expect(screen.getByText(/Última verificación en Meta:/)).toHaveTextContent(
    new Date(checkedAt).toLocaleString("es"),
  );
  expect(screen.getByText(/Vigencia informada por Meta:/)).toHaveTextContent(
    new Date("2026-11-05T00:00:00Z").toLocaleDateString("es", { timeZone: "UTC" }),
  );
});

it("a revisão traduz ações e resultado incerto sem traduzir o conteúdo do anúncio", async () => {
  const draft: AdCampaignDraftDTO = {
    id: "66666666-6666-4666-8666-666666666666",
    revision: 1,
    status: "submitted",
    connection_id: account.connection_id,
    ad_account_asset_id: account.asset_id,
    page_asset_id: "44444444-4444-4444-8444-444444444444",
    name: "Campanha da empresa",
    objective: "OUTCOME_TRAFFIC",
    destination_url: "https://example.com/agenda",
    daily_budget_cents: 3501,
    currency: "BRL",
    starts_at: "2030-01-01T12:00:00Z",
    ends_at: "2030-01-08T12:00:00Z",
    creative: {
      studio_item_id: "55555555-5555-4555-8555-555555555555",
      message: "Conteúdo escrito pela empresa",
      title: "Título escrito pela empresa",
    },
    review_hash: "a".repeat(64),
    approved_hash: "a".repeat(64),
    operation: {
      id: "op-fixture",
      status: "uncertain",
      stage: "campaign_created",
      external_ids: { campaign_id: "101" },
      error_message: null,
    },
  };
  mocks.get.mockImplementation(async (url: string) =>
    url.endsWith(draft.id) ? { data: draft } : { data: { drafts: [draft], pages: [], images: [] } },
  );
  mount(<AdCampaignDrafts account={account} />);
  fireEvent.click(await screen.findByRole("button", { name: "Ver revisión y resultado" }));
  expect(await screen.findByText("Resultado aún no confirmado. No vuelvas a crear")).toBeVisible();
  expect(screen.getByText(draft.creative.message)).toBeVisible();
  expect(screen.getByText(draft.creative.title)).toBeVisible();
  expect(screen.getByRole("button", { name: "Nuevo borrador" })).toBeVisible();
});
