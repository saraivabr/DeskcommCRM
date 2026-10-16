import { apiClient } from "@/lib/api/client";
import type { ApiSuccess } from "@/lib/api/types";

export const STUDIO_READ_TIMEOUT_MS = 20_000;
/** One overall read budget includes API retries. Mutations keep one attempt and their full work budget. */
export async function studioApi<T>(path = "", init: RequestInit = {}): Promise<T> {
  return studioRequest<T>(`/api/v1/instagram${path}`, init);
}
export async function studioRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const controller = new AbortController();
  const timeout =
    method === "GET"
      ? STUDIO_READ_TIMEOUT_MS
      : url === "/api/v1/instagram"
        ? 300_000
        : url === "/api/v1/instagram/publish"
          ? 120_000
          : 30_000;
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException("A consulta demorou demais. Tente novamente.", "TimeoutError"),
      ),
    timeout,
  );
  const signal = init.signal
    ? AbortSignal.any([init.signal, controller.signal])
    : controller.signal;
  const options = {
    signal,
    timeoutMs: timeout,
    headers: Object.fromEntries(new Headers(init.headers)),
  };
  try {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    let response: ApiSuccess<T>;
    if (method === "GET") response = await apiClient.get(url, options);
    else if (method === "POST") response = await apiClient.post(url, body, options);
    else if (method === "PATCH") response = await apiClient.patch(url, body, options);
    else if (method === "DELETE") response = await apiClient.delete(url, body, options);
    else throw new Error("Operação indisponível.");
    return response.data;
  } finally {
    clearTimeout(timer);
  }
}
