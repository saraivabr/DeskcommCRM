/** Uma dependência indisponível não prova que a sessão expirou. */
export const AUTH_TIMEOUT_MS = 8_000;

type AuthFailure = { name?: string; status?: number; code?: string };

export function isAuthUnavailable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const failure = error as AuthFailure;
  return failure.name === "AuthRetryableFetchError" ||
    failure.name === "AuthUnavailableError" ||
    failure.name === "TimeoutError" || failure.name === "AbortError" ||
    failure.status === 0 || failure.status === 408 || failure.status === 429 ||
    (typeof failure.status === "number" && failure.status >= 500);
}

export class AuthUnavailableError extends Error {
  constructor(message = "A verificação de acesso está temporariamente indisponível. Tente novamente.") {
    super(message);
    this.name = "AuthUnavailableError";
  }
}

/** O SDK retenta refresh por até 30s. A tela tem um prazo próprio e não precisa
 * esperar essas retentativas para saber que a verificação está indisponível. */
export async function withAuthDeadline<T>(verify: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      verify(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AuthUnavailableError()), AUTH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export const getUserWithDeadline = withAuthDeadline;
