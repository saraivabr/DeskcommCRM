import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { redirect } from "next/navigation";
import { KnowledgeClient } from "./KnowledgeClient";
export default async function KnowledgePage() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org) redirect("/403");
  return <KnowledgeClient canEdit={ROLE_RANK[org.role] >= ROLE_RANK.agent && !user.support} />;
}
