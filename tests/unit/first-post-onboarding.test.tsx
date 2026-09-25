import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
const { finish, api, push } = vi.hoisted(() => ({
  finish: vi.fn(),
  api: vi.fn<(path?: string, init?: RequestInit) => Promise<unknown>>(),
  push: vi.fn(),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/app/actions/onboarding/finishOnboarding", () => ({ finishOnboarding: finish }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/app/app/instagram/_shared", () => ({
  studioApi: api,
  StudioShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Intro: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Notice: ({ children }: { children: ReactNode }) => <div role="status">{children}</div>,
}));
vi.mock("@/app/app/instagram/_image-generation", () => ({
  ImageGeneration: () => <div>Criando</div>,
}));
import { DoneClient } from "@/app/onboarding/done/_client";
import { CreatePost } from "@/app/app/instagram/_create";
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  finish.mockResolvedValue({ ok: true });
});
it("finaliza o onboarding escolhendo o Studio sem gerar antes da confirmação", async () => {
  render(<DoneClient itens={[]} pecas={[]} />);
  expect(finish).not.toHaveBeenCalled();
  expect(api).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Criar minha primeira postagem" }));
  await waitFor(() => expect(finish).toHaveBeenCalledWith("first_post"));
  expect(api).not.toHaveBeenCalled();
});
it("mantém a saída original disponível", async () => {
  render(<DoneClient itens={[]} pecas={[]} />);
  fireEvent.click(screen.getByRole("button", { name: "Começar a usar" }));
  await waitFor(() => expect(finish).toHaveBeenCalledWith());
});
it("gera no Studio existente apenas após confirmar, preservando contexto e abrindo revisão", async () => {
  api.mockResolvedValue({ id: "post-1" });
  render(
    <CreatePost
      firstPost
      company={{
        name: "Minha empresa",
        logoUrl: null,
        description: "Padaria artesanal",
        descriptionSource: null,
        logoPath: null,
        accent: null,
      }}
      initialNiche="Padaria artesanal"
    />,
  );
  expect(api).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Conte sua ideia"), {
    target: { value: "Mostre nossos pães frescos" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Gerar imagem e legenda" }));
  await waitFor(() => expect(push).toHaveBeenCalledWith("/app/instagram/posts/post-1"));
  const body = api.mock.calls[0]?.[1]?.body;
  if (typeof body !== "string") throw new Error("Studio não recebeu um corpo JSON");
  const payload: unknown = JSON.parse(body);
  expect(payload).toMatchObject({
    kind: "post",
    brief: "Mostre nossos pães frescos",
    niche: "Padaria artesanal",
  });
  expect(api).toHaveBeenCalledTimes(1);
});
it("mantém o pedido e uma saída para a biblioteca quando geração falha", async () => {
  api.mockRejectedValue(new Error("Saldo insuficiente"));
  render(
    <CreatePost
      company={{
        name: "Minha empresa",
        logoUrl: null,
        description: "Padaria",
        descriptionSource: null,
        logoPath: null,
        accent: null,
      }}
      initialNiche="Padaria"
      initialBrief="Mostre nossos pães frescos"
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Gerar imagem e legenda" }));
  expect(await screen.findByText(/Saldo insuficiente/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Abrir minhas criações" })).toHaveAttribute(
    "href",
    "/app/instagram/library",
  );
  expect(screen.getByLabelText("Conte sua ideia")).toHaveValue("Mostre nossos pães frescos");
  expect(push).not.toHaveBeenCalled();
});
