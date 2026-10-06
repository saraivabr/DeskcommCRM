import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  params: new URLSearchParams(),
  readonly: false,
}));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: mocks.get, post: mocks.post } }));
vi.mock("next/navigation", () => ({ useSearchParams: () => mocks.params }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ orgId: "organization-1" }),
  useUser: () => ({ support: mocks.readonly ? { access_mode: "support_readonly" } : undefined }),
}));

import {
  MetaNativeClient,
  type MetaNativeState,
  type MetaNativeAsset,
} from "@/components/connections/MetaNativeClient";

const connectionId = "22222222-2222-4222-8222-222222222222";
const assetId = "33333333-3333-4333-8333-333333333333";
const base: MetaNativeState = {
  configured: true,
  capabilities: { ads_read: true, ads_manage: false, instagram_publish: true },
  connections: [
    {
      id: connectionId,
      actor_name: "Pessoa da empresa",
      status: "selection_pending",
      expires_at: "2030-01-01T00:00:00Z",
      scopes: ["instagram_basic"],
      selected_asset_count: 0,
      reconnect_required: false,
      checked_at: null,
    },
  ],
};
const asset: MetaNativeAsset = {
  id: assetId,
  kind: "instagram",
  name: "Café",
  external_id: "17890000123",
  username: "cafe_qa",
  currency: null,
  timezone: null,
  selected: false,
  capabilities: { ads_read: false, ads_manage: false, instagram_publish: true },
  unavailable_reason: null,
};

function mount(strict = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = (
    <QueryClientProvider client={client}>
      <MetaNativeClient />
    </QueryClientProvider>
  );
  return render(strict ? <StrictMode>{view}</StrictMode> : view);
}

beforeEach(() => {
  mocks.get.mockReset();
  mocks.post.mockReset();
  mocks.params = new URLSearchParams();
  mocks.readonly = false;
  window.history.replaceState({}, "", "/app/connections?aba=sociais");
  mocks.get.mockImplementation(async (path: string) => ({
    data: path.includes("/assets?") ? { assets: [asset] } : structuredClone(base),
  }));
  mocks.post.mockResolvedValue({ data: {} });
});

describe("conexão Meta própria", () => {
  it("sem configuração oferece orientação e bloqueia o início do login", async () => {
    mocks.get.mockResolvedValue({ data: { ...base, configured: false, connections: [] } });
    mount();
    expect(await screen.findByText(/A equipe responsável precisa preparar/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Conectar Facebook e Instagram" })).toBeDisabled();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("falha de leitura não se transforma em integração disponível ou primeira conexão", async () => {
    mocks.get.mockRejectedValue(new Error("Não foi possível consultar a integração."));
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Não foi possível consultar a integração.",
    );
    expect(screen.getByRole("button", { name: "Conectar Facebook e Instagram" })).toBeDisabled();
    expect(screen.queryByText("Nenhuma conta conectada.")).toBeNull();
  });

  it("escolha explícita salva UUID interno e não ID remoto", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Escolher contas" }));
    const checkbox = await screen.findByRole("checkbox", { name: "Selecionar Café" });
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: "Salvar contas escolhidas" }));
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith("/api/v1/integrations/meta/assets", {
        connection_id: connectionId,
        asset_ids: [assetId],
      }),
    );
    expect(JSON.stringify(mocks.post.mock.calls)).not.toContain(asset.external_id);
    expect(await screen.findByRole("status", { name: "Resultado da conexão" })).toHaveTextContent(
      "Contas escolhidas salvas.",
    );
  });

  it("permissão parcial aparece por ativo e não vira tudo autorizado", async () => {
    mocks.get.mockImplementation(async (path: string) => ({
      data: path.includes("/assets?")
        ? {
            assets: [
              {
                ...asset,
                capabilities: { ads_read: false, ads_manage: false, instagram_publish: false },
                unavailable_reason: "Permissão de publicação não concedida.",
              },
            ],
          }
        : base,
    }));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Escolher contas" }));
    expect(await screen.findByText("Sem ações autorizadas para esta conta.")).toBeVisible();
    expect(screen.getByText("Permissão de publicação não concedida.")).toBeVisible();
    expect(screen.queryByText("Publicar no Instagram")).toBeNull();
  });

  it("não chama finalização quando a pessoa cancela no provedor", async () => {
    mocks.params = new URLSearchParams("aba=sociais&meta_error=cancelled");
    window.history.replaceState({}, "", `/app/connections?${mocks.params}`);
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("Você cancelou a autorização.");
    expect(mocks.post).not.toHaveBeenCalled();
    expect(window.location.search).not.toContain("meta_error");
  });

  it("remove ticket da URL e finaliza uma única vez mesmo em StrictMode", async () => {
    mocks.params = new URLSearchParams("aba=sociais&meta_ticket=ticket-opaco");
    window.history.replaceState({}, "", `/app/connections?${mocks.params}`);
    mount(true);
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith("/api/v1/integrations/meta/finalize", {
        ticket: "ticket-opaco",
      }),
    );
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe("?aba=sociais");
    expect(await screen.findByRole("status", { name: "Resultado da conexão" })).toHaveTextContent(
      "Escolha as contas",
    );
    expect(screen.queryByText("Conexão verificada")).toBeNull();
  });

  it("sessão recusada no retorno não anuncia autorização concluída", async () => {
    mocks.params = new URLSearchParams("aba=sociais&meta_ticket=ticket-opaco");
    mocks.post.mockRejectedValue(new Error("Sua sessão mudou. Conecte novamente."));
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Sua sessão mudou. Conecte novamente.",
    );
    expect(screen.queryByRole("status", { name: "Resultado da conexão" })).toBeNull();
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });

  it("desconectar pede confirmação e explica o efeito antes da chamada", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Desconectar Pessoa da empresa" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Publicações e anúncios já existentes continuam na Meta.");
    expect(mocks.post).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Desconectar" }));
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith("/api/v1/integrations/meta/disconnect", {
        connection_id: connectionId,
      }),
    );
  });

  it("suporte somente leitura não oferece escrita ou reconexão", async () => {
    mocks.readonly = true;
    mount();
    expect(await screen.findByText(/Seu acesso de suporte permite apenas consultar/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Conectar Facebook e Instagram" })).toBeDisabled();
    expect(
      await screen.findByRole("button", { name: "Desconectar Pessoa da empresa" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Escolher contas" }));
    expect(await screen.findByRole("checkbox", { name: "Selecionar Café" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Salvar contas escolhidas" })).toBeDisabled();
  });

  it("token vencido mostra próximo passo e não oferece seleção como conexão saudável", async () => {
    mocks.get.mockResolvedValue({
      data: {
        ...base,
        connections: [
          { ...base.connections[0], status: "token_expired", reconnect_required: true },
        ],
      },
    });
    mount();
    expect(await screen.findByText("Autorização expirada")).toBeVisible();
    expect(screen.getByRole("button", { name: "Reconectar Pessoa da empresa" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Escolher contas" })).toBeNull();
  });

  it("verificação remota que encontra revogação atualiza o próximo passo e não declara válida", async () => {
    mocks.post.mockResolvedValue({
      data: {
        ...base,
        connections: [
          {
            ...base.connections[0],
            status: "revoked",
            reconnect_required: true,
            checked_at: "2026-10-05T12:00:00Z",
          },
        ],
      },
    });
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Verificar conexão Pessoa da empresa" }),
    );
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith("/api/v1/integrations/meta/health", {
        connection_id: connectionId,
      }),
    );
    expect(await screen.findByText("Autorização retirada")).toBeVisible();
    expect(screen.getByRole("status", { name: "Resultado da conexão" })).toHaveTextContent(
      "precisa de atenção",
    );
    expect(screen.queryByText("Autorização válida")).toBeNull();
  });

  it("duplo clique de início não cria duas autorizações", async () => {
    let rejectStart: (reason: Error) => void = () => {};
    mocks.post.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectStart = reject;
        }),
    );
    mount();
    await screen.findByRole("button", { name: "Escolher contas" });
    const button = screen.getByRole("button", { name: "Conectar Facebook e Instagram" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledWith("/api/v1/integrations/meta/start", {});
    rejectStart(new Error("A conexão está temporariamente indisponível."));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A conexão está temporariamente indisponível.",
    );
  });

  it("erro de desconexão permanece visível dentro da confirmação aberta", async () => {
    mocks.post.mockRejectedValue(new Error("Não foi possível desconectar. Tente novamente."));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Desconectar Pessoa da empresa" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Desconectar" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Não foi possível desconectar.",
    );
    expect(within(dialog).getByRole("button", { name: "Cancelar" })).toBeEnabled();
  });
});
