import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { MetaNativeClient, type MetaNativeAsset } from "@/components/connections/MetaNativeClient";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), readonly: false }));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: mocks.get, post: mocks.post } }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ orgId: "org-fixture" }),
  useUser: () => ({ support: mocks.readonly ? { access_mode: "support_readonly" } : undefined }),
}));

const assetId = "33333333-3333-4333-8333-333333333333";
const channel = {
  id: "channel-fixture",
  asset_id: assetId,
  platform: "instagram",
  status: "WORKING",
  last_error: null,
};
let assets: MetaNativeAsset[];
let channels: (typeof channel)[];
function mount(locale: "pt-BR" | "es" = "pt-BR") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <IdiomaProvider locale={locale}>
      <QueryClientProvider client={client}>
        <MetaNativeClient />
      </QueryClientProvider>
    </IdiomaProvider>,
  );
}
beforeEach(() => {
  mocks.get.mockReset();
  mocks.post.mockReset();
  mocks.readonly = false;
  assets = [
    {
      id: assetId,
      kind: "instagram",
      external_id: "1789",
      name: "Café",
      username: "cafe",
      currency: null,
      timezone: null,
      selected: true,
      unavailable_reason: null,
      capabilities: {
        ads_read: false,
        ads_manage: false,
        instagram_publish: true,
        instagram_message: true,
      },
    },
  ];
  channels = [];
  mocks.get.mockImplementation(async (path: string) => ({
    data: path.includes("/assets?")
      ? { assets }
      : path.endsWith("/messaging")
        ? { channels }
        : {
            configured: true,
            capabilities: { ads_read: false, ads_manage: false, instagram_publish: true },
            connections: [
              {
                id: "connection-fixture",
                actor_name: "Empresa",
                status: "healthy",
                selected_asset_count: 1,
                reconnect_required: false,
                expires_at: null,
                checked_at: null,
                scopes: [],
              },
            ],
          },
  }));
  mocks.post.mockResolvedValue({ data: { channels: [channel] } });
});

it("habilita o ativo selecionado e distingue assinatura de mensagem recebida", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Receber no atendimento Café" }));
  await waitFor(() =>
    expect(mocks.post).toHaveBeenCalledWith("/api/v1/integrations/meta/messaging", {
      action: "enable",
      asset_id: assetId,
    }),
  );
  expect(await screen.findByRole("status", { name: "Resultado da conexão" })).toHaveTextContent(
    "A primeira mensagem recebida aparecerá no Inbox.",
  );
  expect(screen.getByRole("link", { name: "Abrir Inbox" })).toHaveAttribute("href", "/app/inbox");
  expect(JSON.stringify(mocks.post.mock.calls)).not.toContain("1789");
});

it("permissão ausente bloqueia habilitar e oferece a reconexão", async () => {
  assets[0]!.capabilities.instagram_message = false;
  mount();
  expect(await screen.findByText(/Permissão de mensagens não concedida/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Receber no atendimento Café" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Reconectar para autorizar mensagens" })).toBeEnabled();
  expect(mocks.post).not.toHaveBeenCalled();
});

it("mostra somente ativos escolhidos de Instagram ou Facebook", async () => {
  assets.push(
    { ...assets[0]!, id: "not-selected", name: "Outra conta", selected: false },
    { ...assets[0]!, id: "ads", kind: "ad_account", name: "Anúncios" },
  );
  mount();
  expect(await screen.findByRole("button", { name: "Receber no atendimento Café" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Receber no atendimento Outra conta" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Receber no atendimento Anúncios" })).toBeNull();
});

it("assinatura recusada deixa erro visível e não anuncia habilitação", async () => {
  mocks.post.mockRejectedValue(new Error("A Meta recusou a assinatura de mensagens."));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Receber no atendimento Café" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("A Meta recusou a assinatura");
  expect(screen.queryByRole("status", { name: "Resultado da conexão" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Abrir Inbox" })).toBeNull();
});

it("resposta sem canal ativo nunca se transforma em sucesso", async () => {
  mocks.post.mockResolvedValue({
    data: { channels: [{ ...channel, status: "FAILED", last_error: "Assinatura não confirmada" }] },
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Receber no atendimento Café" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Atualize o estado antes de tentar novamente",
  );
  expect(screen.queryByRole("status", { name: "Resultado da conexão" })).toBeNull();
});

it("pausar preserva a porta para o histórico e confirma estado STOPPED", async () => {
  channels = [channel];
  mocks.post.mockResolvedValue({ data: { channels: [{ ...channel, status: "STOPPED" }] } });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Pausar recebimento Café" }));
  await waitFor(() =>
    expect(mocks.post).toHaveBeenCalledWith("/api/v1/integrations/meta/messaging", {
      action: "disable",
      asset_id: assetId,
    }),
  );
  expect(await screen.findByRole("status", { name: "Resultado da conexão" })).toHaveTextContent(
    "O histórico permanece no Inbox.",
  );
  expect(screen.getByRole("link", { name: "Abrir Inbox" })).toBeVisible();
});

it("suporte de consulta não habilita nem pausa mensagens", async () => {
  mocks.readonly = true;
  channels = [channel];
  mount();
  expect(await screen.findByRole("button", { name: "Pausar recebimento Café" })).toBeDisabled();
  expect(screen.getByRole("link", { name: "Abrir Inbox" })).toBeVisible();
  expect(mocks.post).not.toHaveBeenCalled();
});

it("o estado de atendimento e a ação têm tradução em espanhol", async () => {
  mount("es");
  expect(await screen.findByRole("button", { name: "Recibir en atención Café" })).toBeEnabled();
  expect(screen.getByText("Mensajes en atención")).toBeVisible();
});

it("falha de consulta não é exibida como canal desabilitado", async () => {
  const original = mocks.get.getMockImplementation()!;
  mocks.get.mockImplementation((path: string) =>
    path.endsWith("/messaging")
      ? Promise.reject(new Error("Não foi possível consultar os canais de atendimento."))
      : original(path),
  );
  mount();
  expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível consultar");
  expect(screen.queryByRole("button", { name: "Receber no atendimento Café" })).toBeNull();
  expect(screen.getByRole("button", { name: "Consultar atendimento novamente" })).toBeEnabled();
});

it("Facebook usa sua permissão própria e mantém o contrato de ativo interno", async () => {
  assets[0] = {
    ...assets[0]!,
    kind: "page",
    capabilities: {
      ads_read: false,
      ads_manage: false,
      instagram_publish: false,
      instagram_message: false,
      facebook_message: true,
    },
  };
  mount();
  const button = await screen.findByRole("button", { name: "Receber no atendimento Café" });
  expect(screen.getByText("Página do Facebook · Café")).toBeVisible();
  expect(button).toBeEnabled();
  fireEvent.click(button);
  await waitFor(() =>
    expect(mocks.post).toHaveBeenCalledWith("/api/v1/integrations/meta/messaging", {
      action: "enable",
      asset_id: assetId,
    }),
  );
});

it("duplo clique não repete a inscrição e exibe a operação em andamento", async () => {
  let complete: (result: { data: { channels: (typeof channel)[] } }) => void = () => {};
  mocks.post.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  mount();
  const button = await screen.findByRole("button", { name: "Receber no atendimento Café" });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(mocks.post).toHaveBeenCalledTimes(1);
  expect(button).toBeDisabled();
  expect(screen.getByText("Habilitando atendimento…")).toBeVisible();
  complete({ data: { channels: [channel] } });
  expect(await screen.findByRole("status", { name: "Resultado da conexão" })).toHaveTextContent(
    "Recebimento habilitado",
  );
});
