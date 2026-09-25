import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Role } from "@/lib/auth/types";
import { ToolsCatalog } from "./ToolsCatalog";

let role: Role = "admin";
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ user: { is_platform_admin: false }, activeOrg: { role } }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (key: string) => key }));
afterEach(cleanup);

describe("catálogo de ferramentas", () => {
  it("busca por objetivo e abre a porta real, permitindo recuperar uma busca vazia", () => {
    role = "admin";
    render(<ToolsCatalog />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Buscar ferramentas" }), {
      target: { value: "etapas" },
    });
    expect(screen.getByRole("link", { name: /Etapas do funil/ })).toHaveAttribute(
      "href",
      "/app/settings/tenant/pipelines",
    );
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "nenhum-destino-assim" } });
    expect(screen.getByRole("heading", { name: "Nenhuma ferramenta encontrada" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Limpar filtros" }));
    expect(screen.getByRole("link", { name: /^Inbox/ })).toBeVisible();
  });
  it("um atendente não recebe links administrativos mesmo ao pesquisar", () => {
    role = "agent";
    render(<ToolsCatalog />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "credenciais" } });
    expect(screen.queryByRole("link", { name: /Credenciais/ })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("0 ferramentas disponíveis");
  });
});
