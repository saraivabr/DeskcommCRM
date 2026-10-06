import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ operador: vi.fn(), idioma: vi.fn() }));
vi.mock("@/lib/legal/operador", () => ({ resolverOperador: mocks.operador }));
vi.mock("@/lib/i18n/idiomaAnonimo", () => ({ idiomaDoVisitante: mocks.idioma }));

import Page, { generateMetadata } from "./page";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.idioma.mockResolvedValue("pt-BR");
  mocks.operador.mockResolvedValue({ dpoEmail: null });
});

it("explica o pedido e oferece contato sem inventar um endereço", async () => {
  render(await Page());
  expect(screen.getByRole("heading", { name: "Como solicitar" })).toBeVisible();
  expect(document.body).toHaveTextContent("Os arquivos originais do Studio");
  expect(document.body).toHaveTextContent("dados de atendimento do CRM");
  expect(document.body).toHaveTextContent("canais de atendimento que você já utiliza");
  expect(screen.queryByRole("link", { name: /@/ })).toBeNull();
  expect(screen.getByRole("link", { name: "Política de Privacidade" })).toHaveAttribute(
    "href",
    "/legal/privacy",
  );
});

it("usa somente o contato de encarregado resolvido para esta instalação", async () => {
  mocks.operador.mockResolvedValue({ dpoEmail: "privacidade@example.test" });
  render(await Page());
  expect(screen.getByRole("link", { name: "privacidade@example.test" })).toHaveAttribute(
    "href",
    "mailto:privacidade@example.test",
  );
});

it("traduz as instruções e seu título e evita indexação", async () => {
  mocks.idioma.mockResolvedValue("es");
  render(await Page());
  expect(
    screen.getByRole("heading", { name: "Eliminar datos de la conexión con Meta" }),
  ).toBeVisible();
  expect(screen.getByRole("heading", { name: "Qué se elimina" })).toBeVisible();
  expect(document.body).toHaveTextContent("Los archivos originales del Studio");
  expect(await generateMetadata()).toEqual({
    title: "Eliminar datos de la conexión con Meta",
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  });
});
