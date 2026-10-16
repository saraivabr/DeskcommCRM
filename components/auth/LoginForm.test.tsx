import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Component, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";
import { getRedirectError } from "next/dist/client/components/redirect";
import { RedirectType } from "next/navigation";
const mocks = vi.hoisted(() => ({ signIn: vi.fn(), replace: vi.fn() }));
vi.mock("@/app/actions/auth/signInWithPassword", () => ({ signInWithPassword: mocks.signIn }));
vi.mock("next/navigation", async (importOriginal) => ({ ...await importOriginal<Record<string, unknown>>(), useRouter: () => ({ replace: mocks.replace }) }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (text: string) => text }));
import { LoginForm } from "./LoginForm";

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks(); });

class RedirectBoundaryProbe extends Component<{ children: ReactNode; onError: (error: Error) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { this.props.onError(error); }
  render() { return this.state.failed ? <span>Next controla o redirect</span> : this.props.children; }
}

describe("login recuperável", () => {
  it("só aceita credenciais depois de hidratar o formulário entregue pelo servidor", async () => {
    mocks.signIn.mockResolvedValue({ ok: false, error: "auth_unavailable" });
    const container = document.createElement("div");
    container.innerHTML = renderToString(<LoginForm next="/app" />);
    document.body.append(container);
    const form = within(container);
    const email = form.getByLabelText("Email") as HTMLInputElement;
    const password = form.getByLabelText("Senha") as HTMLInputElement;
    const submit = form.getByRole("button", { name: "Entrar" });
    let root: Root | undefined;
    try {
      expect(email).toBeDisabled();
      expect(password).toBeDisabled();
      expect(submit).toBeDisabled();
      await act(async () => { root = hydrateRoot(container, <LoginForm next="/app" />); });
      expect(email).toBeEnabled();
      expect(password).toBeEnabled();
      expect(submit).toBeEnabled();
      fireEvent.change(email, { target: { value: "user@example.com" } });
      fireEvent.change(password, { target: { value: "example-password" } });
      fireEvent.click(submit);
      await waitFor(() => expect(mocks.signIn).toHaveBeenCalledWith(
        { email: "user@example.com", password: "example-password" }, "/app",
      ));
      await waitFor(() => expect(form.getByRole("alert")).toHaveTextContent("Tente novamente"));
      expect(email).toHaveValue("user@example.com");
      expect(password).toHaveValue("example-password");
    } finally {
      await act(async () => root?.unmount());
      container.remove();
    }
  });
  it("redirect real do Next atravessa o catch e chega ao boundary", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const redirect = getRedirectError("/app", RedirectType.push);
    const onError = vi.fn();
    mocks.signIn.mockRejectedValue(redirect);
    render(<RedirectBoundaryProbe onError={onError}><LoginForm /></RedirectBoundaryProbe>);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "user@example.com" } });
    fireEvent.change(screen.getByLabelText("Senha"), { target: { value: "example-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith(redirect));
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it.each(["response", "network"])("indisponibilidade %s mostra tentar novamente, mantém formulário e libera botão", async (mode) => {
    if (mode === "response") mocks.signIn.mockResolvedValue({ ok: false, error: "auth_unavailable" });
    else mocks.signIn.mockRejectedValue(new TypeError("fetch failed"));
    render(<LoginForm next="/app/inbox" />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "user@example.com" } });
    fireEvent.change(screen.getByLabelText("Senha"), { target: { value: "example-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Tente novamente em instantes"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Entrar" })).toBeEnabled());
    expect(screen.queryByText("Email ou senha incorretos.")).toBeNull();
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});
