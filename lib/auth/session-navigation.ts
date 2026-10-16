import { safeNext } from "@/lib/auth/safe-next";

let redirecting = false;

/** Só a sessão da aplicação pode tirar a pessoa da tela. Um provider pode
 * responder 401/invalid_credentials sem que a sessão do CRM tenha terminado. */
export function isSessionExpired(status: number, code: string | undefined): boolean {
  return status === 401 && (code === "unauthenticated" || code === "token_expired" || code === "token_revoked");
}

export function loginForExpiredSession(path: string): string | null {
  const next = safeNext(path, "/app");
  const pathname = new URL(next, "https://app.invalid").pathname;
  if (pathname === "/login" || pathname.startsWith("/login/") || pathname.startsWith("/auth/")) return null;
  return `/login?${new URLSearchParams({ next })}`;
}

/** replace impede voltar à casca expirada. A trava coalesce 401 simultâneos e
 * a tela de login nunca redireciona para si mesma. Nenhuma escrita é repetida. */
export function redirectExpiredSession(): void {
  if (typeof window === "undefined" || redirecting) return;
  const destination = loginForExpiredSession(window.location.pathname + window.location.search + window.location.hash);
  if (!destination) return;
  redirecting = true;
  window.location.replace(destination);
}
