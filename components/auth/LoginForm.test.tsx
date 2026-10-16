import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Component, type ReactNode } from "react";
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
    expect((screen.getByRole("button", { name: "Entrar" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText("Email ou senha incorretos.")).toBeNull();
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});
