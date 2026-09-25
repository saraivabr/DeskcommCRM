import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UserMenu } from "@/components/shell/UserMenu";

const setTheme = vi.fn();
const applyLanguage = vi.fn();
const saveLanguage = vi.fn();
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useUser: () => ({ full_name: "Pessoa Teste", email: "pessoa@example.test", is_platform_admin: false }),
  useAuth: () => ({ signOut: vi.fn() }),
}));
vi.mock("@/lib/theme", () => ({ useTheme: () => ({ theme: "light", setTheme }) }));
vi.mock("@/lib/i18n/IdiomaProvider", () => ({
  useIdioma: () => "pt-BR",
  useAplicarIdioma: () => applyLanguage,
  useT: () => (key: string) => key,
}));
vi.mock("@/app/actions/settings/trocarIdioma", () => ({ trocarIdioma: (...args: unknown[]) => saveLanguage(...args) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("preferências do usuário por teclado", () => {
  it("alcança tema pelas setas e aciona com Enter", async () => {
    const user = userEvent.setup();
    render(<UserMenu />);
    screen.getByRole("button", { name: "Menu do usuário" }).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByTestId("seletor-de-idioma")).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: /^Tema:/ })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(setTheme).toHaveBeenCalledWith("dark");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Menu do usuário" })).toHaveFocus());
  });
  it("abre idiomas com seta direita e salva a seleção pelo teclado", async () => {
    saveLanguage.mockResolvedValue({ ok: false });
    const user = userEvent.setup();
    render(<UserMenu />);
    screen.getByRole("button", { name: "Menu do usuário" }).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByTestId("seletor-de-idioma")).toHaveFocus());
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(screen.getByTestId("idioma-pt-BR")).toHaveFocus());
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(saveLanguage).toHaveBeenCalledWith("es"));
    expect(applyLanguage).toHaveBeenCalledWith("es");
    expect(applyLanguage).toHaveBeenLastCalledWith("pt-BR");
  });
});
