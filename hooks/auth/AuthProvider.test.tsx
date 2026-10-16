import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { AuthUser } from "@/lib/auth/types";

const mocks = vi.hoisted(() => ({ get: vi.fn(), reset: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: mocks.get } }));
vi.mock("@/lib/supabase/browser", () => ({ resetRealtimeAuthentication: mocks.reset }));
vi.mock("@/app/providers", () => ({ Providers: ({ children }: { children: ReactNode }) => children }));
import { AuthProvider } from "./AuthProvider";

const user: AuthUser = { id: "user", email: "user@example.com", full_name: null, avatar_url: null, is_platform_admin: false, idioma: "pt-BR", organizations: [] };

beforeEach(() => {
  vi.useFakeTimers();
  mocks.get.mockReset().mockResolvedValue({ data: { authenticated: true } });
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("AuthProvider renova cookie somente na mesma origem", () => {
  it("verifica periodicamente sem chamar refreshSession inacessível no browser", async () => {
    const { unmount } = render(<AuthProvider user={user} activeOrg={null}><span>App</span></AuthProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.get.mock.calls[0]?.[0]).toBe("/api/v1/auth/session");
    const signal = mocks.get.mock.calls[0]?.[1].signal as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);
  });

  it("falha transitória permite outra verificação sem desmontar o app", async () => {
    mocks.get.mockRejectedValueOnce(new Error("503"));
    const screen = render(<AuthProvider user={user} activeOrg={null}><span>App</span></AuthProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(screen.getByText("App")).toBeTruthy();
  });

  it("não sonda aba oculta e verifica ao voltar sem rajada de focus", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    render(<AuthProvider user={user} activeOrg={null}><span>App</span></AuthProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
    expect(mocks.get).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });
});
