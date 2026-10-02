import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (text: string) => text }));

import { ProspectingClient } from "@/app/app/prospecting/_client";
import { ProspectingScheduleForm } from "@/app/app/prospecting/_schedule";
import type { CampaignConfig } from "@/lib/prospecting/schema";

const seller = {
  seller_name: "Sara",
  company_name: "Saraiva.AI",
  offer: "Organizamos o atendimento no WhatsApp e o retorno aos interessados.",
};
const CHANNEL = "22222222-2222-4222-8222-222222222222";
const PIPELINE = "33333333-3333-4333-8333-333333333333";
const STAGE = "44444444-4444-4444-8444-444444444444";
const QUALIFIED = "44444444-4444-4444-8444-444444444445";
const AGENT = "55555555-5555-4555-8555-555555555555";
const legacyConfig: CampaignConfig = {
  agent_id: AGENT,
  channel_session_id: CHANNEL,
  pipeline_id: PIPELINE,
  stage_id: STAGE,
  qualified_stage_id: QUALIFIED,
  instruction: "Oferecer uma avaliação comercial apenas para clínicas.",
  qualification: "A clínica quer marcar uma demonstração.",
  daily_limit: 10,
  interval_minutes: 15,
  legal_basis_ref: "Avaliação real registrada pelo operador",
};
function fixture() {
  const campaigns = ["Clínicas de estética", "Restaurantes"].map((niche, index) => ({
    id: `11111111-1111-4111-8111-11111111111${index}`,
    name: `${niche} · São Paulo`,
    search: {
      source: "google_maps" as const,
      name: `${niche} · São Paulo`,
      niche,
      location: "São Paulo",
      limit: 20,
      budget_usd: 1,
      enrich: true,
    },
    status: "draft",
    search_status: "succeeded",
    error: null,
    config: null as CampaignConfig | null,
    result_count: 1,
    skipped_count: 0,
    cost_usd: "0.10",
    next_send_at: "2026-10-01T00:00:00Z",
  }));
  return {
    configured: true,
    seller: { ...seller },
    campaigns,
    candidates: campaigns.map((campaign, index) => ({
      id: `candidate-${index}`,
      campaign_id: campaign.id,
      progress: "new",
      message_status: null,
      error: null,
      conversation_id: null,
      data: {
        name: "Empresa de teste",
        category: "Serviços",
        phone: null,
        address: null,
        website: null,
        rating: null,
        reviews: 0,
        emails: [],
        socials: [],
      },
    })),
    channels: [{ id: CHANNEL, display_name: "Comercial", phone_number: null, status: "WORKING" }],
    stages: [
      { id: STAGE, name: "Novos", pipeline_id: PIPELINE, pipeline_name: "Comercial" },
      { id: QUALIFIED, name: "Qualificados", pipeline_id: PIPELINE, pipeline_name: "Comercial" },
    ],
  };
}
let state: ReturnType<typeof fixture>;
function openPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <ProspectingClient />
    </QueryClientProvider>,
  );
  return { ...view, client };
}
function completeOperation() {
  fireEvent.change(screen.getByLabelText("Etapa inicial"), { target: { value: STAGE } });
  fireEvent.change(screen.getByLabelText("Etapa de qualificados"), {
    target: { value: QUALIFIED },
  });
  fireEvent.change(screen.getByLabelText("Referência da avaliação de legítimo interesse"), {
    target: { value: "Avaliação registrada" },
  });
}
const startCalls = () => api.post.mock.calls.filter(([, body]) => body.action === "start");
const agentCalls = () =>
  [...api.get.mock.calls, ...api.post.mock.calls].filter(([url]) => /\/agents(?:\/|$)/.test(url));
beforeEach(() => {
  vi.clearAllMocks();
  state = fixture();
  api.get.mockImplementation(async () => ({ data: JSON.parse(JSON.stringify(state)) }));
  api.post.mockImplementation(async (_url, body) => {
    if (body.action === "save_seller") state.seller = { ...body.profile };
    return { data: {} };
  });
});
afterEach(cleanup);

describe("vendedora padrão da prospecção", () => {
  it("usa a mesma identidade e oferta em clínicas e restaurantes, sem criar ou selecionar agentes", async () => {
    openPage();
    await screen.findByRole("heading", { name: "Sara · Saraiva.AI" });
    expect(
      screen.queryByRole("region", { name: "Configuração por conversa" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Funcionário responsável")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Gerenciar Funcionários" })).not.toBeInTheDocument();
    expect(screen.getByTestId("prospecting-niche-context")).toHaveTextContent(
      "Clínicas de estética",
    );
    expect(screen.getByLabelText("Oferta desta campanha")).toHaveValue(seller.offer);
    completeOperation();
    fireEvent.click(screen.getByRole("button", { name: "Iniciar abordagens" }));
    await waitFor(() => expect(startCalls()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: /Restaurantes · São Paulo/ }));
    expect(screen.getByTestId("prospecting-niche-context")).toHaveTextContent("Restaurantes");
    expect(screen.getByRole("heading", { name: "Sara · Saraiva.AI" })).toBeInTheDocument();
    expect(screen.getByLabelText("Oferta desta campanha")).toHaveValue(seller.offer);
    completeOperation();
    fireEvent.click(screen.getByRole("button", { name: "Iniciar abordagens" }));
    await waitFor(() => expect(startCalls()).toHaveLength(2));
    for (const [, body] of startCalls()) {
      expect(body.config).not.toHaveProperty("agent_id");
      expect(body.config).not.toHaveProperty("standard_seller");
      expect(body.config.instruction).toBe(seller.offer);
    }
    expect(agentCalls()).toHaveLength(0);
  });

  it("mostra o perfil incompleto e o salva uma vez sem iniciar campanha", async () => {
    state.seller.offer = "";
    openPage();
    await screen.findByLabelText("Nome da vendedora");
    expect(screen.getByLabelText("Nome da vendedora")).toHaveValue("Sara");
    fireEvent.change(screen.getByLabelText("Nome da vendedora"), { target: { value: "Clara" } });
    fireEvent.change(screen.getByLabelText("Como sua empresa ajuda os clientes"), {
      target: { value: seller.offer },
    });
    fireEvent.click(screen.getByRole("button", { name: "Salvar apresentação e oferta" }));
    await screen.findByRole("heading", { name: "Clara · Saraiva.AI" });
    expect(api.post).toHaveBeenCalledWith("/api/v1/prospecting", {
      action: "save_seller",
      profile: { ...seller, seller_name: "Clara" },
    });
    expect(startCalls()).toHaveLength(0);
    expect(agentCalls()).toHaveLength(0);
  });

  it("preserva perfil e oferta por campanha ainda não salvos durante atualizações", async () => {
    const { client } = openPage();
    await screen.findByRole("heading", { name: "Sara · Saraiva.AI" });
    fireEvent.click(screen.getByRole("button", { name: "Configurar apresentação e oferta" }));
    fireEvent.change(screen.getByLabelText("Nome da vendedora"), {
      target: { value: "Clara em edição" },
    });
    fireEvent.change(screen.getByLabelText("Oferta desta campanha"), {
      target: { value: "Minha oferta ainda em edição para esta campanha" },
    });
    state.seller.seller_name = "Outro nome salvo";
    state.seller.offer = "Outra oferta que veio do servidor";
    await client.refetchQueries({ queryKey: ["prospecting"] });
    expect(screen.getByLabelText("Nome da vendedora")).toHaveValue("Clara em edição");
    expect(screen.getByLabelText("Oferta desta campanha")).toHaveValue(
      "Minha oferta ainda em edição para esta campanha",
    );
    fireEvent.click(screen.getByRole("button", { name: /Restaurantes · São Paulo/ }));
    expect(screen.getByLabelText("Oferta desta campanha")).toHaveValue(state.seller.offer);
    fireEvent.click(screen.getByRole("button", { name: /Clínicas de estética · São Paulo/ }));
    expect(screen.getByLabelText("Oferta desta campanha")).toHaveValue(
      "Minha oferta ainda em edição para esta campanha",
    );
  });

  it("bloqueia novas edições durante o salvamento da apresentação", async () => {
    state.seller.offer = "";
    let finishSave!: () => void;
    api.post.mockImplementation(async (_url, body) => {
      await new Promise<void>((resolve) => {
        finishSave = resolve;
      });
      state.seller = { ...body.profile };
      return { data: {} };
    });
    openPage();
    await screen.findByLabelText("Nome da vendedora");
    fireEvent.change(screen.getByLabelText("Como sua empresa ajuda os clientes"), {
      target: { value: seller.offer },
    });
    fireEvent.click(screen.getByRole("button", { name: "Salvar apresentação e oferta" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    for (const label of [
      "Nome da vendedora",
      "Empresa que representa",
      "Como sua empresa ajuda os clientes",
    ])
      expect(screen.getByLabelText(label)).toBeDisabled();
    finishSave();
    await screen.findByRole("heading", { name: "Sara · Saraiva.AI" });
  });

  it("preserva a configuração congelada das campanhas legadas", async () => {
    state.campaigns[0]!.config = legacyConfig;
    openPage();
    expect(await screen.findByLabelText("Oferta desta campanha")).toBeDisabled();
    expect(screen.getByLabelText("Oferta desta campanha")).toHaveValue(legacyConfig.instruction);
    fireEvent.click(screen.getByRole("button", { name: "Iniciar abordagens" }));
    await waitFor(() => expect(startCalls()).toHaveLength(1));
    expect(startCalls()[0]![1].config).toEqual(legacyConfig);
    expect(agentCalls()).toHaveLength(0);
  });

  it("envia o novo segmento na busca sem começar abordagens", async () => {
    openPage();
    await screen.findByRole("heading", { name: "Sara · Saraiva.AI" });
    fireEvent.click(screen.getByRole("button", { name: "Nova busca de empresas" }));
    fireEvent.change(screen.getByLabelText("Onde buscar"), { target: { value: "instagram" } });
    fireEvent.change(screen.getByLabelText("Público ou segmento"), {
      target: { value: "Restaurantes" },
    });
    fireEvent.change(screen.getByLabelText("Cidade ou região"), { target: { value: "São Paulo" } });
    fireEvent.click(screen.getByRole("button", { name: "Buscar empresas" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/api/v1/prospecting",
        expect.objectContaining({
          action: "search",
          search: expect.objectContaining({ source: "instagram", niche: "Restaurantes" }),
        }),
      ),
    );
    expect(startCalls()).toHaveLength(0);
    expect(agentCalls()).toHaveLength(0);
  });
});

it("reutiliza apenas a operação na recorrência; identidade e oferta vêm do perfil padrão", async () => {
  const perform = vi.fn(async (_body: unknown, _message: string) => true);
  render(
    <ProspectingScheduleForm
      seller={seller}
      busy={false}
      schedule={null}
      campaigns={[
        {
          id: "legacy",
          name: "Campanha de clínicas",
          config: {
            ...legacyConfig,
            standard_seller: {
              ...seller,
              seller_name: "Antiga",
              offer: "Oferta antiga apenas de clínicas",
            },
          },
        },
      ]}
      perform={perform}
    />,
  );
  fireEvent.change(screen.getByLabelText("Público da recorrência"), {
    target: { value: "Restaurantes" },
  });
  fireEvent.change(screen.getByLabelText("Região da recorrência"), { target: { value: "SP" } });
  fireEvent.change(screen.getByLabelText("Abordagem após cada busca"), {
    target: { value: "legacy" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Salvar recorrência desligada", hidden: true }),
  );
  await waitFor(() => expect(perform).toHaveBeenCalledTimes(1));
  const body = perform.mock.calls[0]![0] as unknown as {
    action: string;
    config: { search: { niche: string }; campaign_config: Record<string, unknown> };
  };
  expect(body.action).toBe("save_schedule");
  expect(body.config.search.niche).toBe("Restaurantes");
  expect(body.config.campaign_config).not.toHaveProperty("agent_id");
  expect(body.config.campaign_config).not.toHaveProperty("standard_seller");
  expect(body.config.campaign_config.instruction).toBe(seller.offer);
  expect(body.config.campaign_config.channel_session_id).toBe(CHANNEL);
  expect(body.config.campaign_config.pipeline_id).toBe(PIPELINE);
  expect(body.config.campaign_config.qualification).toBe(
    "Demonstrou interesse na oferta e quer avançar para uma conversa comercial.",
  );
});

it("exige salvar mudanças na recorrência antes de permitir sua ativação", () => {
  const perform = vi.fn(async (_body: unknown, _message: string) => true);
  render(
    <ProspectingScheduleForm
      seller={seller}
      busy={false}
      campaigns={[]}
      perform={perform}
      schedule={{
        schedule_config: {
          search: {
            source: "google_maps",
            name: "Restaurantes · SP",
            niche: "Restaurantes",
            location: "SP",
            limit: 20,
            budget_usd: 1,
            enrich: true,
          },
          interval_hours: 24,
          max_runs: 5,
          total_budget_usd: 5,
          campaign_config: null,
        },
        schedule_enabled: false,
        schedule_runs: 0,
        schedule_reserved_usd: "0",
        schedule_next_at: null,
        schedule_request_id: null,
        schedule_campaign_id: null,
        schedule_error: null,
      }}
    />,
  );
  const activate = screen.getByRole("button", { name: "Ativar buscas automáticas", hidden: true });
  expect(activate).toBeEnabled();
  fireEvent.change(screen.getByLabelText("Região da recorrência"), { target: { value: "RJ" } });
  expect(activate).toBeDisabled();
  fireEvent.click(activate);
  expect(perform).not.toHaveBeenCalled();
});
