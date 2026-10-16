import { AUTH_TIMEOUT_MS } from "@/lib/auth/availability";

/** Um orçamento por cliente SSR: o SDK pode tentar refresh novamente, mas não
 * volta à rede depois do prazo. Abort é retryable no auth-js e preserva a sessão.
 * Queries PostgREST continuam com seus próprios prazos/AbortSignals. */
export function createAuthFetch(readSignal?: AbortSignal): typeof fetch & { hasTimedOut: () => boolean } {
  let authDeadline: AbortSignal | undefined;
  const boundedFetch: typeof fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const isAuth = url.pathname.startsWith("/auth/v1/");
    if (!isAuth && !readSignal) return fetch(input, init);
    if (isAuth) authDeadline ??= AbortSignal.timeout(AUTH_TIMEOUT_MS);
    const originalSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signals = [originalSignal, readSignal, isAuth ? authDeadline : undefined].filter((signal): signal is AbortSignal => !!signal);
    const signal = AbortSignal.any(signals);
    return fetch(input, { ...init, signal });
  };
  return Object.assign(boundedFetch, { hasTimedOut: () => !!(authDeadline?.aborted || readSignal?.aborted) });
}
