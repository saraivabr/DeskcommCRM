import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const rows = vi.hoisted(() => ({ value: [] as Array<Record<string, unknown>> }));
const scope = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/server", () => ({
  requireAuth: async () => ({ idioma: "pt-BR" }),
  resolveActiveOrg: async () => ({ orgId: "org-active", role: "manager" }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({
      select: () => ({
        eq: (...args: unknown[]) => {
          scope(...args);
          return { order: async () => ({ data: rows.value }) };
        },
      }),
    }),
  }),
}));
vi.mock("../pipelines/[id]/_client", () => ({
  PipelinePageClient: ({ pipelineId }: { pipelineId: string }) => <div>Quadro {pipelineId}</div>,
}));
vi.mock("./_client", () => ({ FunisClient: () => <div>Gerenciar funis</div> }));
vi.mock("@/components/brand/ArtisanIcon", () => ({ ArtisanIcon: () => null }));
import Page from "./page";

beforeEach(() => {
  scope.mockClear();
  rows.value = [
    { id: "first", name: "Primeiro", is_archived: false, is_default: false },
    { id: "default", name: "Principal", is_archived: false, is_default: true },
    { id: "archived", name: "Arquivado", is_archived: true, is_default: true },
  ];
});

it("abre o quadro padrão da organização ativa", async () => {
  render(await Page({ searchParams: Promise.resolve({}) }));
  expect(screen.getByText("Quadro default")).toBeInTheDocument();
  expect(scope).toHaveBeenCalledWith("organization_id", "org-active");
});
it("mantém a lista de gestão acessível", async () => {
  render(await Page({ searchParams: Promise.resolve({ view: "manage" }) }));
  expect(screen.getByText("Gerenciar funis")).toBeInTheDocument();
});
it("mostra a gestão quando só existem funis arquivados", async () => {
  rows.value = rows.value.filter((row) => row.is_archived);
  render(await Page({ searchParams: Promise.resolve({}) }));
  expect(screen.getByText("Gerenciar funis")).toBeInTheDocument();
});
