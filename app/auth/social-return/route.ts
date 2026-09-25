import { createHash } from "node:crypto";
import { marcaDaSaida } from "@/lib/branding/saida";

// Uma navegação externa de OAuth omite cookies de sessão sob SameSite=Strict.
// Entregar um documento estático same-origin antes de redirecionar para a tela
// autenticada restaura o envio normal dos cookies na navegação seguinte.
// Esta página não realiza vínculos e não confia em parâmetros da query.
const target = "/app/connections?aba=sociais";
const script = `window.location.replace(${JSON.stringify(target)});`;
const hash = createHash("sha256").update(script).digest("base64");

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function GET() {
  const marca = await marcaDaSaida(null);
  const nome = escapeHtml(marca.nome);

  return new Response(
    `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Voltando ao ${nome}</title><body><p>Voltando para suas conexões…</p><a href="${target}">Continuar no ${nome}</a><script>${script}</script></body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": `default-src 'none'; script-src 'sha256-${hash}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
      },
    },
  );
}
