import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CommercialAccountCard } from "./CommercialAccountCard";
import { DEFAULT_COMMERCIAL_ACCOUNT } from "@/lib/billing/entitlements";
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => translate }));
const translate = (text: string) => text;
afterEach(() => vi.unstubAllGlobals());
it("blocks saving an old account while a different tenant loads or fails", async () => {
  let failSecond!: (error: Error) => void;
  const fetch = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { account: DEFAULT_COMMERCIAL_ACCOUNT, can_edit: true } }),
    })
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failSecond = reject;
        }),
    );
  vi.stubGlobal("fetch", fetch);
  const { rerender } = render(<CommercialAccountCard organizationId="a" />);
  await act(async () => {});
  expect(
    screen.getByRole("button", { name: "Salvar classificação" }).closest("fieldset"),
  ).not.toHaveAttribute("disabled");
  rerender(<CommercialAccountCard organizationId="b" />);
  expect(
    screen.getByRole("button", { name: "Salvar classificação" }).closest("fieldset"),
  ).toHaveAttribute("disabled");
  fireEvent.click(screen.getByRole("button", { name: "Salvar classificação" }));
  expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => {
    failSecond(new Error("unavailable"));
  });
  expect(
    screen.getByRole("button", { name: "Salvar classificação" }).closest("fieldset"),
  ).toHaveAttribute("disabled");
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("retains UTC dates entered by input events when enabling Free and saving", async () => {
  const account = { ...DEFAULT_COMMERCIAL_ACCOUNT, classification: "free_public" };
  const fetch = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({ data: { account, can_edit: true } }) });
  vi.stubGlobal("fetch", fetch);
  render(<CommercialAccountCard organizationId="dates" />);
  await act(async () => {});
  fireEvent.input(screen.getByLabelText("Início do período (UTC)"), {
    target: { value: "2026-09-25T00:00" },
  });
  fireEvent.input(screen.getByLabelText("Fim do período (UTC)"), {
    target: { value: "2026-10-25T00:00" },
  });
  fireEvent.click(screen.getByLabelText("Habilitar Free neste período"));
  expect(screen.getByLabelText("Início do período (UTC)")).toHaveValue("2026-09-25T00:00");
  expect(screen.getByLabelText("Fim do período (UTC)")).toHaveValue("2026-10-25T00:00");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Salvar classificação" }));
  });
  expect(fetch).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.objectContaining({
      body: expect.stringContaining('"free_period_start":"2026-09-25T00:00:00.000Z"'),
    }),
  );
});
