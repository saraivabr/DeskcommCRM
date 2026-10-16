import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({ result: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const query = { select: () => query, eq: () => query, is: () => query, maybeSingle: deps.result };
      return query;
    },
  }),
}));
import { exigenciaDeMfa } from "@/lib/auth/server";
import { AUTH_TIMEOUT_MS, AuthUnavailableError } from "@/lib/auth/availability";

beforeEach(() => { deps.result.mockReset(); });
afterEach(() => vi.useRealTimers());

describe("a leitura da política de MFA indisponível não desliga a exigência", () => {
  it("recusa erro de leitura da organização em vez de assumir MFA opcional", async () => {
    deps.result.mockResolvedValue({ data: null, error: { code: "57014" } });
    await expect(exigenciaDeMfa("admin", false, "user", "org")).rejects.toBeInstanceOf(AuthUnavailableError);
  });
  it("recusa erro da regra da plataforma antes de usar a regra da empresa", async () => {
    deps.result.mockResolvedValue({ data: null, error: { code: "57014" } });
    await expect(exigenciaDeMfa("admin", true, "user", "org")).rejects.toBeInstanceOf(AuthUnavailableError);
  });
  it("limita a espera sem transformar indisponibilidade em autorização", async () => {
    vi.useFakeTimers();
    deps.result.mockImplementation(() => new Promise(() => {}));
    const result = expect(exigenciaDeMfa("admin", false, "user", "org")).rejects.toBeInstanceOf(AuthUnavailableError);
    await vi.advanceTimersByTimeAsync(AUTH_TIMEOUT_MS);
    await result;
  });
  it("conserva a política legada e permite ausência explícita de exigência", async () => {
    deps.result.mockResolvedValueOnce({ data: { settings: { security: { mfa_required: true } } }, error: null });
    expect(await exigenciaDeMfa("admin", false, "user", "org")).toMatchObject({ exige: true, bloqueia: true });
    deps.result.mockResolvedValueOnce({ data: { settings: {} }, error: null });
    expect(await exigenciaDeMfa("admin", false, "user", "org")).toMatchObject({ exige: false, bloqueia: false });
  });
});
