import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  WorkspaceAssistantProvider,
  WorkspaceAssistantTrigger,
  WorkspaceComposer,
} from "@/components/workspace/WorkspaceAssistant";
const m = vi.hoisted(() => ({
  ask: vi.fn(),
  path: "/app/inbox",
  auth: { user: { id: "u1" }, activeOrg: { orgId: "org1", role: "admin" } },
}));
vi.mock("@/app/app/_workspace-action", () => ({ askWorkspace: m.ask }));
vi.mock("next/navigation", () => ({ usePathname: () => m.path }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: () => m.auth }));
function App() {
  return (
    <WorkspaceAssistantProvider>
      <WorkspaceAssistantTrigger />
      <WorkspaceComposer />
    </WorkspaceAssistantProvider>
  );
}
function input() {
  return within(screen.getByRole("dialog")).getByRole("textbox");
}
function open() {
  fireEvent.click(screen.getByRole("button", { name: "Escreve aí" }));
}
function send(text = "Resumo") {
  fireEvent.change(input(), { target: { value: text } });
  fireEvent.keyDown(input(), { key: "Enter" });
}
beforeEach(() => {
  vi.resetAllMocks();
  m.path = "/app/inbox";
  m.auth.activeOrg = { orgId: "org1", role: "admin" };
  m.ask.mockResolvedValue({ ok: true, answer: "Resposta", sources: [], notice: "20 conversas" });
  Object.defineProperty(window, "SpeechRecognition", { configurable: true, value: undefined });
  Object.defineProperty(window, "webkitSpeechRecognition", {
    configurable: true,
    value: undefined,
  });
});
describe("assistente global", () => {
  it("usa contexto da rota; respeita Shift, repetição e composição; envia uma vez", async () => {
    render(<App />);
    open();
    expect(within(screen.getByRole("dialog")).getByLabelText("Onde consultar")).toHaveValue(
      "conversations",
    );
    fireEvent.change(input(), { target: { value: "Resumo" } });
    for (const options of [
      { shiftKey: true },
      { repeat: true },
      { isComposing: true },
      { keyCode: 229 },
    ])
      fireEvent.keyDown(input(), { key: "Enter", ...options });
    expect(m.ask).not.toHaveBeenCalled();
    fireEvent.keyDown(input(), { key: "Enter" });
    fireEvent.keyDown(input(), { key: "Enter" });
    await screen.findByText("Resposta");
    expect(m.ask).toHaveBeenCalledTimes(1);
    expect(m.ask.mock.calls[0]?.[0].scope).toBe("conversations");
  });
  it("Home abre o mesmo drawer e as fontes ficam em disclosure", async () => {
    m.ask.mockResolvedValue({
      ok: true,
      answer: "Ana precisa de retorno",
      sources: [{ id: "c1", kind: "Conversa", title: "Ana", href: "/app/inbox?id=c1" }],
      notice: "20 conversas",
    });
    render(<App />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Quem precisa de retorno?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Enviar pergunta" }));
    await screen.findByText("Ana precisa de retorno");
    fireEvent.click(screen.getByText(/Fontes e recorte da consulta/));
    expect(screen.getByRole("link", { name: "Conversa · Ana" })).toHaveAttribute(
      "href",
      "/app/inbox?id=c1",
    );
    expect(screen.getByText(/Não acompanha alterações posteriores/)).toBeInTheDocument();
    send("Mais detalhes");
    await waitFor(() => expect(m.ask).toHaveBeenCalledTimes(2));
    expect(m.ask.mock.calls[1]?.[0].history).toHaveLength(2);
  });
  it("preserva pergunta em erro e zera dados ao mudar organização", async () => {
    m.ask.mockRejectedValueOnce(new Error("offline"));
    const view = render(<App />);
    open();
    send();
    await screen.findByRole("alert");
    expect(input()).toHaveValue("Resumo");
    send();
    await screen.findByText("Resposta");
    m.auth.activeOrg.orgId = "org2";
    view.rerender(<App />);
    expect(screen.queryByText("Resposta")).toBeNull();
    open();
    send();
    await waitFor(() => expect(m.ask).toHaveBeenCalledTimes(3));
    expect(m.ask.mock.calls[2]?.[0].history).toEqual([]);
  });
  it("oculta conhecimento para perfil sem acesso", () => {
    m.auth.activeOrg.role = "agent";
    m.path = "/app/ai/knowledge/sources";
    render(<App />);
    open();
    expect(within(screen.getByRole("dialog")).getByLabelText("Onde consultar")).toHaveValue("all");
    expect(screen.queryByRole("option", { name: "Conteúdos" })).toBeNull();
  });
  it("voz indisponível tem retorno explícito sem enviar pergunta", () => {
    render(<App />);
    open();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Falar" }));
    expect(screen.getByText(/não está disponível neste navegador/)).toBeInTheDocument();
    expect(m.ask).not.toHaveBeenCalled();
  });
  it("voz só começa no clique e entrega transcrição editável sem enviar", () => {
    const start = vi.fn();
    const abort = vi.fn();
    let session: { onresult: (e: unknown) => void; onend: () => void };
    const register = (instance: typeof session) => {
      session = instance;
    };
    class Recognition {
      start = start;
      abort = abort;
      stop = vi.fn();
      onresult = (_event: unknown) => {};
      onend = () => {};
      constructor() {
        register(this);
      }
    }
    Object.defineProperty(window, "SpeechRecognition", { configurable: true, value: Recognition });
    const view = render(<App />);
    expect(start).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Texto inicial" } });
    fireEvent.click(screen.getByRole("button", { name: "Falar" }));
    expect(start).toHaveBeenCalledOnce();
    open();
    expect(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Enviar pergunta" }),
    ).toBeDisabled();
    expect(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Falar" }),
    ).toBeDisabled();
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(m.ask).not.toHaveBeenCalled();
    fireEvent.change(input(), { target: { value: "Texto revisado" } });
    act(() => {
      session.onresult({ results: [[{ transcript: "Minhas oportunidades" }]] });
      session.onend();
    });
    expect(input()).toHaveValue("Texto revisado Minhas oportunidades");
    expect(m.ask).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Falar" }));
    view.unmount();
    expect(abort).toHaveBeenCalledOnce();
  });
});
