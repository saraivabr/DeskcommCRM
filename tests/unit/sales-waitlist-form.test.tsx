import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (text: string) => text }));
import { WaitlistForm } from "@/app/(public)/lista-de-espera/_form";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function fill() {
  fireEvent.change(screen.getByLabelText("Seu nome"), { target: { value: "Maria" } });
  fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "maria@example.com" } });
}
it("envia interesse e deixa explícito que não criou conta ou convite", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetch);
  render(<WaitlistForm />);
  fill();
  fireEvent.click(screen.getByRole("button", { name: "Entrar na lista de espera" }));
  expect(await screen.findByRole("status")).toHaveTextContent(
    "não cria uma conta nem garante um convite",
  );
  expect(fetch).toHaveBeenCalledWith(
    "/api/v1/sales/waitlist",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ name: "Maria", email: "maria@example.com", company: "", website: "" }),
    }),
  );
  expect(screen.getByRole("link", { name: "Já tenho acesso" })).toHaveAttribute("href", "/login");
});
it("falha não parece sucesso e permite repetir com os dados preservados", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
  render(<WaitlistForm />);
  fill();
  fireEvent.click(screen.getByRole("button", { name: "Entrar na lista de espera" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Tente novamente");
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByLabelText("Seu nome")).toHaveValue("Maria");
  await waitFor(() => expect(screen.getByRole("button")).toBeEnabled());
});
