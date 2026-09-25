"use server";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { homeInputSchema, loadHomeOverview, type HomeOverview } from "@/lib/workspace/home";

export async function getHomeOverview(
  input: unknown,
): Promise<{ ok: true; data: HomeOverview } | { ok: false; message: string }> {
  const parsed = homeInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Escolha um período e um escopo válidos." };
  const auth = await requireRole(parsed.data.scope === "team" ? "manager" : "viewer", {
    resource: "workspace_home",
  });
  if (!auth.ok)
    return {
      ok: false,
      message: "Não foi possível autorizar esta consulta. Confira sua sessão e suas permissões.",
    };
  try {
    return {
      ok: true,
      data: await loadHomeOverview(
        await createClient(),
        auth.org.orgId,
        auth.user.id,
        auth.org.role,
        parsed.data,
      ),
    };
  } catch {
    return {
      ok: false,
      message: "Não foi possível carregar sua operação. Tente atualizar novamente.",
    };
  }
}
