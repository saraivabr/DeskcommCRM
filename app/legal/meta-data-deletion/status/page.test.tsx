import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ status: vi.fn(), idioma: vi.fn() }));
vi.mock("@/lib/channels/meta/social/removal", () => ({
  getMetaDeletionStatus: mocks.status,
}));
vi.mock("@/lib/i18n/idiomaAnonimo", () => ({ idiomaDoVisitante: mocks.idioma }));

import Page, { generateMetadata } from "./page";

const code = "a".repeat(64);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.idioma.mockResolvedValue("pt-BR");
  mocks.status.mockResolvedValue(null);
});

describe("acompanhamento público da exclusão Meta", () => {
  it.each(["pending", "processing"])("mantém %s em andamento", async (status) => {
    mocks.status.mockResolvedValue(status);
    render(await Page({ searchParams: Promise.resolve({ code }) }));
    expect(screen.getByRole("heading", { name: "Exclusão em processamento" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Exclusão concluída" })).toBeNull();
  });

  it("só mostra conclusão quando a consulta a confirma", async () => {
    mocks.status.mockResolvedValue("completed");
    render(await Page({ searchParams: Promise.resolve({ code }) }));
    expect(screen.getByRole("heading", { name: "Exclusão concluída" })).toBeVisible();
    expect(mocks.status).toHaveBeenCalledWith(code);
    expect(document.body).not.toHaveTextContent(code);
  });

  it("uma falha não confirma conclusão nem exibe a mensagem interna", async () => {
    mocks.status.mockRejectedValue(new Error("remote_actor_id=private-subject"));
    render(await Page({ searchParams: Promise.resolve({ code }) }));
    expect(
      screen.getByRole("heading", { name: "Consulta temporariamente indisponível" }),
    ).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Exclusão concluída" })).toBeNull();
    expect(document.body).not.toHaveTextContent("private-subject");
    expect(screen.getByRole("link", { name: "Instruções de exclusão e contato" })).toHaveAttribute(
      "href",
      "/legal/meta-data-deletion",
    );
  });

  it.each([undefined, "", "a".repeat(63), "a".repeat(65), "G".repeat(64), [code, code]])(
    "não consulta códigos ausentes, malformados ou repetidos: %j",
    async (value) => {
      render(await Page({ searchParams: Promise.resolve({ code: value }) }));
      expect(screen.getByRole("heading", { name: "Pedido não encontrado" })).toBeVisible();
      expect(mocks.status).not.toHaveBeenCalled();
      expect(document.body).not.toHaveTextContent(code);
    },
  );

  it("um código desconhecido tem a mesma orientação pública", async () => {
    render(await Page({ searchParams: Promise.resolve({ code }) }));
    expect(screen.getByRole("heading", { name: "Pedido não encontrado" })).toBeVisible();
    expect(document.body).not.toHaveTextContent(code);
  });

  it("traduz o acompanhamento e impede indexação e referrer no metadata", async () => {
    mocks.idioma.mockResolvedValue("es");
    mocks.status.mockResolvedValue("completed");
    render(await Page({ searchParams: Promise.resolve({ code }) }));
    expect(screen.getByRole("heading", { name: "Eliminación completada" })).toBeVisible();
    expect(await generateMetadata()).toEqual({
      title: "Seguimiento de la eliminación de datos de Meta",
      robots: { index: false, follow: false },
      referrer: "no-referrer",
    });
  });
});
