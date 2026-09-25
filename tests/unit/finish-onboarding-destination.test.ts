import { beforeEach, expect, it, vi } from "vitest";
const { redirect, query } = vi.hoisted(() => ({ redirect: vi.fn(), query: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/app/actions/onboarding/_shared", () => ({
  requireOnboardingCtx: async () => ({ orgId: "org-1", userId: "user-1" }),
  OnboardingError: class extends Error {},
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: query }),
}));
import { finishOnboarding } from "@/app/actions/onboarding/finishOnboarding";
beforeEach(() => {
  vi.clearAllMocks();
  query.mockReturnValue({
    select: () => ({
      eq: () => ({ maybeSingle: async () => ({ data: { onboarded_at: "2026-09-25" } }) }),
    }),
  });
});
it("retorna ao Studio após finalizar para a primeira postagem", async () => {
  await finishOnboarding("first_post");
  expect(redirect).toHaveBeenCalledWith("/app/instagram/new?first_post=1");
});
it("mantém destino padrão e não aceita URL externa mesmo em chamada manipulada", async () => {
  await finishOnboarding();
  expect(redirect).toHaveBeenLastCalledWith("/app/inbox");
  await finishOnboarding("https://example.org" as "first_post");
  expect(redirect).toHaveBeenLastCalledWith("/app/inbox");
});
