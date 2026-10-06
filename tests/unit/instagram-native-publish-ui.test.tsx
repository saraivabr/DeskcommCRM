import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PublishPost } from "@/app/app/instagram/_publish";
import type { StudioItem } from "@/lib/instagram/schema";
import type { Publication } from "@/lib/instagram/publication-schema";
import { LEGACY_INSTAGRAM_PUBLICATION_PROVIDER } from "@/lib/channels/social/instagram-publishing";
const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/app/app/instagram/_shared", () => ({
  studioApi: api,
  Notice: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
const item: StudioItem = {
  id: "bfea9c32-58e8-4fc7-ae88-1d8d04972874",
  kind: "post",
  status: "ready",
  input: {
    id: "bfea9c32-58e8-4fc7-ae88-1d8d04972874",
    kind: "post",
    brief: "Teste da publicação",
    niche: "Produto",
    use_logo: false,
    format: "feed",
    caption: "",
  },
  caption: "Legenda",
  answer: "",
  sources: [],
  asset_path: null,
  error: null,
  created_at: "",
  updated_at: "",
};
const native = {
  id: "01111111-1111-4111-8111-111111111111",
  provider: "meta" as const,
  meta_asset_id: "01111111-1111-4111-8111-111111111111",
  connection_id: "02222222-2222-4222-8222-222222222222",
  username: "nativo",
  active: true,
  story_eligible: false,
};
const legacy = {
  id: "aaaaaaaaaaaaaaaaaaaaaaaa",
  provider: LEGACY_INSTAGRAM_PUBLICATION_PROVIDER,
  username: "anterior",
  active: true,
};
let state: {
  accounts: (typeof native | typeof legacy)[];
  publications: Publication[];
  can_publish: boolean;
};
beforeEach(() => {
  state = { accounts: [native, legacy], publications: [], can_publish: true };
  api.mockImplementation(() => Promise.resolve(state));
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.useRealTimers();
});
async function mount() {
  render(<PublishPost item={item} caption="Legenda" />);
  await screen.findByRole("combobox");
}
function chooseNative(connection = native.connection_id) {
  fireEvent.change(screen.getByRole("combobox"), {
    target: { value: `meta:${connection}:${native.id}` },
  });
}
async function confirm() {
  fireEvent.click(screen.getByRole("button", { name: "Revisar publicação" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirmar publicação" }));
  await waitFor(() =>
    expect(api.mock.calls.some(([, options]) => options?.method === "POST")).toBe(true),
  );
}
function sent() {
  return api.mock.calls
    .filter(([, options]) => options?.method === "POST")
    .map(([, options]) => JSON.parse(options.body));
}
it("exige conta explícita e envia UUIDs da conexão Meta, sem account_id legado", async () => {
  await mount();
  expect(screen.getByRole("button", { name: "Revisar publicação" })).toBeDisabled();
  chooseNative();
  await confirm();
  expect(sent()[0]).toMatchObject({
    provider: "meta",
    meta_asset_id: native.id,
    connection_id: native.connection_id,
    item_ids: [item.id],
    caption: "Legenda",
  });
  expect(sent()[0]).not.toHaveProperty("account_id");
});
it("preserva payload da conexão existente escolhida explicitamente", async () => {
  await mount();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: `legacy:${legacy.id}` } });
  await confirm();
  expect(sent()[0]).toMatchObject({ account_id: legacy.id });
  expect(sent()[0]).not.toHaveProperty("meta_asset_id");
});
it("não troca para conexão existente ao atualizar uma conta nativa revogada", async () => {
  await mount();
  chooseNative();
  state = { ...state, accounts: [legacy] };
  fireEvent.click(screen.getByRole("button", { name: "Atualizar resultado" }));
  await waitFor(() => expect(screen.getByRole("combobox")).toHaveValue(""));
  expect(screen.getByRole("button", { name: "Revisar publicação" })).toBeDisabled();
  expect(sent()).toHaveLength(0);
});
it("mantém conexão exata quando duas autorizações expõem o mesmo Instagram", async () => {
  const otherConnection = "03333333-3333-4333-8333-333333333333";
  state.accounts = [native, { ...native, connection_id: otherConnection }];
  await mount();
  chooseNative(otherConnection);
  await confirm();
  expect(sent()[0].connection_id).toBe(otherConnection);
});
it("atualização de resultado incerto só lê e nunca publica novamente", async () => {
  state.publications = [
    {
      id: "p",
      account_id: "1784",
      provider: "meta",
      meta_asset_id: native.id,
      connection_id: native.connection_id,
      operation_id: "op",
      requested_by: "u",
      item_ids: [item.id],
      format: "feed",
      caption: "Legenda",
      status: "uncertain",
      provider_post_id: null,
      permalink: null,
      error: "Envio não confirmado",
      created_at: "",
    },
  ];
  await mount();
  chooseNative();
  expect(screen.getByRole("button", { name: "Revisar publicação" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Atualizar resultado" }));
  await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  expect(sent()).toHaveLength(0);
});
it("não envia Stories sem elegibilidade confirmada da conta Meta", async () => {
  render(
    <PublishPost
      item={{
        ...item,
        input: { ...item.input, kind: "post", format: "story" } as StudioItem["input"],
      }}
      caption=""
    />,
  );
  await screen.findByRole("combobox");
  chooseNative();
  expect(screen.getByRole("button", { name: "Revisar publicação" })).toBeDisabled();
  expect(screen.getByText(/ainda não confirmou a permissão para Stories/)).toBeVisible();
});
it("acompanha processamento por leitura e para quando chega comprovante", async () => {
  vi.useFakeTimers();
  state.publications = [
    {
      id: "p",
      account_id: "1784",
      provider: "meta",
      meta_asset_id: native.id,
      connection_id: native.connection_id,
      operation_id: "op",
      requested_by: "u",
      item_ids: [item.id],
      format: "feed",
      caption: "Legenda",
      status: "pending",
      provider_post_id: null,
      permalink: null,
      error: null,
      created_at: "",
    },
  ];
  render(<PublishPost item={item} caption="Legenda" />);
  await act(async () => {});
  state = {
    ...state,
    publications: state.publications.map((p) => ({
      ...p,
      status: "published" as const,
      permalink: "https://www.instagram.com/p/prova/",
    })),
  };
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(screen.getByRole("link", { name: "Ver no Instagram" })).toBeVisible();
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(api).toHaveBeenCalledTimes(2);
  expect(sent()).toHaveLength(0);
});

it("exibe a fonte indisponível sem selecionar outra conexão automaticamente", async () => {
  api.mockResolvedValue({
    ...state,
    accounts: [legacy],
    provider_errors: { native: "Reconecte a conta Meta.", legacy: null },
  });
  await mount();
  expect(screen.getByText("Conexão Meta: Reconecte a conta Meta.")).toBeVisible();
  expect(screen.getByRole("combobox")).toHaveValue("");
  expect(screen.getByRole("button", { name: "Revisar publicação" })).toBeDisabled();
});
