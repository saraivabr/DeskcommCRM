import { cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const original = Reflect.getOwnPropertyDescriptor(globalThis, "Notification");

function comPermissaoDoNavegador(valor: string): void {
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    writable: true,
    value: { permission: valor, requestPermission: vi.fn() },
  });
}

afterEach(() => {
  cleanup();
  if (original) Object.defineProperty(globalThis, "Notification", original);
  else Reflect.deleteProperty(globalThis, "Notification");
  vi.resetModules();
});

async function componente() {
  vi.resetModules();
  const { NotificationPrefsClient } = await import("@/app/app/settings/notifications/_client");
  return NotificationPrefsClient;
}

function botoesPushDesabilitados(markup: string): boolean[] {
  return [...markup.matchAll(/<button[^>]*aria-label="[^"]*via push"[^>]*>/g)].map((m) =>
    /\sdisabled[=\s>]/.test(m[0]),
  );
}

describe("permissão de notificações e hidratação", () => {
  it.each(["denied", "granted"])(
    "usa o mesmo HTML seguro na primeira renderização com permissão %s",
    async (permissao) => {
      const NotificationPrefsClient = await componente();
      Reflect.deleteProperty(globalThis, "Notification");
      const htmlServidor = renderToStaticMarkup(<NotificationPrefsClient />);
      comPermissaoDoNavegador(permissao);
      const htmlPrimeiraPassada = renderToStaticMarkup(<NotificationPrefsClient />);

      expect(botoesPushDesabilitados(htmlServidor).length).toBeGreaterThan(0);
      expect(botoesPushDesabilitados(htmlServidor).every(Boolean)).toBe(true);
      expect(htmlPrimeiraPassada).toBe(htmlServidor);
    },
  );

  it("aplica a permissão concedida após montar, mesmo sem VAPID", async () => {
    expect(process.env.VAPID_PUBLIC_KEY ?? "").toBe("");
    comPermissaoDoNavegador("granted");
    const NotificationPrefsClient = await componente();
    const { container } = render(<NotificationPrefsClient />);
    expect(botoesPushDesabilitados(container.innerHTML).length).toBeGreaterThan(0);
    expect(botoesPushDesabilitados(container.innerHTML).some(Boolean)).toBe(false);
  });

  it("mantém o Push desabilitado e explica a permissão negada após montar", async () => {
    comPermissaoDoNavegador("denied");
    const NotificationPrefsClient = await componente();
    const { container } = render(<NotificationPrefsClient />);
    expect(botoesPushDesabilitados(container.innerHTML).every(Boolean)).toBe(true);
    expect(container.textContent).toContain("O navegador bloqueou as notificações");
  });
});
