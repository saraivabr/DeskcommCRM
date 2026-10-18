import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";

import { EntendedorClient } from "./_client";

export const dynamic = "force-dynamic";

/**
 * Qualquer membro vê o consumo; só administrador liga, desliga e muda as
 * preferências — a mesma régua da rota e da RLS.
 */
export default async function EntendedorPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/403");
  return <EntendedorClient podeEditar={ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin} />;
}
