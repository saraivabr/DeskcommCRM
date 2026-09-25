import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkspaceHome } from "@/app/app/_components/WorkspaceHome";
const mocks = vi.hoisted(() => ({
  overview: vi.fn(),
  open: vi.fn(),
  auth: { user: { id: "u1" }, activeOrg: { orgId: "org1", name: "Empresa", role: "admin" } },
}));
vi.mock("@/app/app/_home-action", () => ({ getHomeOverview: mocks.overview }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: () => mocks.auth }));
vi.mock("@/components/workspace/WorkspaceAssistant", () => ({
  WorkspaceComposer: () => <div>Composer compartilhado</div>,
  useWorkspaceAssistant: () => ({ openAssistant: mocks.open, canKnowledge: true, busy: false }),
}));
function response(canSeeTeam = false) {
  return {
    ok: true,
    data: {
      scope: "mine",
      canSeeTeam,
      updatedAt: "2026-09-25T12:00:00Z",
      attention: [
        {
          id: "tasks",
          label: "Tarefas atrasadas",
          description: "Prazo vencido",
          href: "/app/tasks",
          count: null,
        },
      ],
      movement: [],
      activities: [],
    },
  };
}
beforeEach(() => {
  mocks.auth.activeOrg.orgId = "org1";
  mocks.open.mockReset();
  mocks.overview.mockReset().mockResolvedValue(response());
});
describe("Home produtiva", () => {
  it("usa título aprovado, composer único e padrão pessoal sem opção equipe não autorizada", async () => {
    render(<WorkspaceHome />);
    expect(screen.getByRole("heading", { name: "O que vamos resolver hoje?" })).toBeInTheDocument();
    expect(screen.getByText("Composer compartilhado")).toBeInTheDocument();
    await screen.findByText("Tarefas atrasadas");
    expect(mocks.overview).toHaveBeenCalledWith({ scope: "mine", days: 7 });
    expect(screen.queryByRole("option", { name: "Ver a equipe" })).toBeNull();
    expect(
      screen.getByText("Não foi possível consultar. Atualize para tentar novamente."),
    ).toBeInTheDocument();
  });
  it("opção da equipe depende da autorização devolvida pelo servidor e troca consulta", async () => {
    mocks.overview.mockResolvedValue(response(true));
    render(<WorkspaceHome />);
    await screen.findByRole("option", { name: "Ver a equipe" });
    fireEvent.change(screen.getByRole("combobox", { name: "Escopo das pendências" }), {
      target: { value: "team" },
    });
    await waitFor(() =>
      expect(mocks.overview).toHaveBeenLastCalledWith({ scope: "team", days: 7 }),
    );
  });
  it("falha fica visível e permite repetir", async () => {
    mocks.overview.mockRejectedValueOnce(new Error("offline"));
    render(<WorkspaceHome />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Atualizar operação" }));
    await screen.findByText("Tarefas atrasadas");
  });
  it("troca organização limpa dados e volta ao escopo pessoal", async () => {
    mocks.overview.mockResolvedValue(response(true));
    const view = render(<WorkspaceHome />);
    await screen.findByText("Tarefas atrasadas");
    fireEvent.change(screen.getByRole("combobox", { name: "Escopo das pendências" }), {
      target: { value: "team" },
    });
    await waitFor(() =>
      expect(mocks.overview).toHaveBeenLastCalledWith({ scope: "team", days: 7 }),
    );
    mocks.auth.activeOrg.orgId = "org2";
    view.rerender(<WorkspaceHome />);
    await waitFor(() =>
      expect(mocks.overview).toHaveBeenLastCalledWith({ scope: "mine", days: 7 }),
    );
  });
  it("sugestão abre o assistente compartilhado com escopo", () => {
    render(<WorkspaceHome />);
    fireEvent.click(screen.getByRole("button", { name: "Resuma as conversas recentes" }));
    expect(mocks.open).toHaveBeenCalledWith("Resuma as conversas recentes", "conversations");
  });
});
