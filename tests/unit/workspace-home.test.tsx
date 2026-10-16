import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkspaceHome } from "@/app/app/_components/WorkspaceHome";
const mocks = vi.hoisted(() => ({
  overview: vi.fn(),
  open: vi.fn(),
  send: vi.fn(),
  auth: { user: { id: "u1" }, activeOrg: { orgId: "org1", name: "Empresa", role: "admin" } },
}));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: mocks.overview } }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: () => mocks.auth }));
vi.mock("@/components/workspace/WorkspaceAssistant", () => ({
  useWorkspaceAssistant: () => ({
    openAssistant: mocks.open,
    canKnowledge: true,
    busy: false,
    question: "",
    setQuestion: vi.fn(),
    listening: false,
    setListening: vi.fn(),
    send: mocks.send,
  }),
}));
function response(canSeeTeam = false) {
  return {
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
  mocks.send.mockReset();
  mocks.overview.mockReset().mockResolvedValue(response());
});
describe("Home produtiva", () => {
  it("mostra horário de hoje e data para atividade antiga, com instante completo acessível", async () => {
    const today = new Date();
    today.setHours(8, 30, 0, 0);
    const old = new Date(today);
    old.setFullYear(old.getFullYear() - 1);
    const result = response();
    mocks.overview.mockResolvedValue({
      ...result,
      data: {
        ...result.data,
        activities: [
          {
            id: "today",
            title: "Conversa de hoje",
            at: today.toISOString(),
            href: "/app/inbox?id=today",
          },
          { id: "old", title: "Conversa antiga", at: old.toISOString(), href: "/app/inbox?id=old" },
        ],
      },
    });
    render(<WorkspaceHome />);
    const todayLink = await screen.findByRole("link", { name: /Conversa de hoje/ });
    const oldLink = screen.getByRole("link", { name: /Conversa antiga/ });
    expect(todayLink.querySelector("time")).toHaveTextContent(
      today.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    );
    expect(oldLink.querySelector("time")).toHaveTextContent(
      old.toLocaleDateString([], { day: "2-digit", month: "2-digit", year: "numeric" }),
    );
    expect(oldLink.querySelector("time")).toHaveAttribute("title", old.toLocaleString());
    expect(oldLink.querySelector("time")).toHaveAttribute("datetime", old.toISOString());
  });

  it("usa título aprovado, composer único e padrão pessoal sem opção equipe não autorizada", async () => {
    render(<WorkspaceHome />);
    expect(screen.getByRole("heading", { name: "Visão geral" })).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "O que você quer saber sobre seu CRM?" }),
    ).toBeInTheDocument();
    await screen.findByText("Tarefas atrasadas");
    expect(mocks.overview).toHaveBeenCalledWith("/api/v1/workspace/home?scope=mine&days=7", {
      signal: expect.any(AbortSignal),
      timeoutMs: 20_000,
    });
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
      expect(mocks.overview).toHaveBeenLastCalledWith(
        "/api/v1/workspace/home?scope=team&days=7",
        expect.any(Object),
      ),
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
      expect(mocks.overview).toHaveBeenLastCalledWith(
        "/api/v1/workspace/home?scope=team&days=7",
        expect.any(Object),
      ),
    );
    mocks.auth.activeOrg.orgId = "org2";
    view.rerender(<WorkspaceHome />);
    await waitFor(() =>
      expect(mocks.overview).toHaveBeenLastCalledWith(
        "/api/v1/workspace/home?scope=mine&days=7",
        expect.any(Object),
      ),
    );
  });
  it("sugestão abre o assistente compartilhado com escopo", async () => {
    render(<WorkspaceHome />);
    await screen.findByText("Tarefas atrasadas");
    fireEvent.click(screen.getByRole("button", { name: "Resuma o dia" }));
    expect(mocks.open).toHaveBeenCalledWith("Resuma o dia", "all");
  });
  it("envia pergunta da Home no escopo completo mesmo após outro escopo no assistente", async () => {
    render(<WorkspaceHome />);
    await screen.findByText("Tarefas atrasadas");
    const input = screen.getByRole("textbox", { name: "O que você quer saber sobre seu CRM?" });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(mocks.send).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mocks.send).toHaveBeenCalledWith("all");
  });
});

describe("recuperação de uma consulta presa", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("cancela a consulta sem resposta, libera Atualizar e repete com sucesso", async () => {
    mocks.overview.mockImplementationOnce(() => new Promise(() => {}));
    render(<WorkspaceHome />);
    const signal = mocks.overview.mock.calls[0]![1].signal as AbortSignal;
    expect(screen.getByRole("button", { name: "Atualizar operação" })).toBeDisabled();
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(signal.aborted).toBe(true);
    expect(screen.getByRole("alert")).toHaveTextContent("Tente atualizar novamente.");
    expect(screen.getByRole("button", { name: "Atualizar operação" })).toBeEnabled();
    expect(screen.queryByText("Consultando sua operação…")).not.toBeInTheDocument();

    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Atualizar operação" })),
    );
    expect(mocks.overview).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Tarefas atrasadas")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("uma resposta atrasada não sobrescreve a tentativa seguinte nem seu loading", async () => {
    let oldFinish!: (value: ReturnType<typeof response>) => void;
    let newFinish!: (value: ReturnType<typeof response>) => void;
    mocks.overview
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            oldFinish = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            newFinish = resolve;
          }),
      );
    render(<WorkspaceHome />);
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    fireEvent.click(screen.getByRole("button", { name: "Atualizar operação" }));

    const old = response();
    old.data.attention[0]!.label = "Resposta antiga";
    await act(async () => oldFinish(old));
    expect(screen.queryByText("Resposta antiga")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Atualizar operação" })).toBeDisabled();

    await act(async () => newFinish(response()));
    expect(screen.getByText("Tarefas atrasadas")).toBeInTheDocument();
    expect(screen.queryByText("Resposta antiga")).not.toBeInTheDocument();
  });

  it("sair da Home cancela a requisição e limpa seu prazo", async () => {
    mocks.overview.mockImplementationOnce(() => new Promise(() => {}));
    const view = render(<WorkspaceHome />);
    const signal = mocks.overview.mock.calls[0]![1].signal as AbortSignal;
    await act(() => vi.advanceTimersByTimeAsync(0));
    view.unmount();
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("mantém o último snapshot enquanto atualiza a operação", async () => {
  mocks.overview.mockResolvedValueOnce(response());
  let finish!: (value: ReturnType<typeof response>) => void;
  mocks.overview.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<WorkspaceHome />);
  await screen.findByText("Tarefas atrasadas");
  fireEvent.click(screen.getByRole("button", { name: "Atualizar operação" }));
  expect(await screen.findByText("Atualizando sua operação…")).toBeInTheDocument();
  expect(screen.getByText("Tarefas atrasadas")).toBeInTheDocument();
  finish(response());
  await waitFor(() =>
    expect(screen.queryByText("Atualizando sua operação…")).not.toBeInTheDocument(),
  );
});
