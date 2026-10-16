import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getUser: vi.fn(), permission: vi.fn(), aal: vi.fn(), redirect: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const chain = { select: () => chain, eq: () => chain, is: () => chain, maybeSingle: mocks.permission };
    return { auth: { getUser: mocks.getUser, mfa: { getAuthenticatorAssuranceLevel: mocks.aal } }, from: () => chain };
  },
}));
import { requirePlatformAdmin } from "./requirePlatformAdmin";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: "admin" } }, error: null });
  mocks.permission.mockResolvedValue({ data: { user_id: "admin", scope: "full", mfa_required: true }, error: null });
  mocks.aal.mockResolvedValue({ data: { currentLevel: "aal2" }, error: null });
  mocks.redirect.mockImplementation((path: string) => { throw new Error(`redirect:${path}`); });
});

describe("admin preserva sessão durante falha de infraestrutura", () => {
  it.each(["identity", "permissions", "mfa"])("%s indisponível falha fechado sem redirect enganoso", async (step) => {
    if (step === "identity") mocks.getUser.mockResolvedValue({ data: { user: null }, error: { status: 504 } });
    if (step === "permissions") mocks.permission.mockResolvedValue({ data: null, error: { code: "PGRST002" } });
    if (step === "mfa") mocks.aal.mockResolvedValue({ data: null, error: { status: 503 } });
    await expect(requirePlatformAdmin()).rejects.toMatchObject({ name: "AuthUnavailableError" });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
  it("sessão ausente continua no login", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { name: "AuthSessionMissingError", status: 400 } });
    await expect(requirePlatformAdmin()).rejects.toThrow("redirect:/login?next=/admin");
  });
  it("ausência real de papel continua proibida", async () => {
    mocks.permission.mockResolvedValue({ data: null, error: null });
    await expect(requirePlatformAdmin()).rejects.toThrow("redirect:/admin/forbidden");
  });
  it("admin com sessão, papel e fator comprovados continua autorizado", async () => {
    await expect(requirePlatformAdmin()).resolves.toMatchObject({ user: { id: "admin" }, platformAdmin: { scope: "full" } });
  });
});
