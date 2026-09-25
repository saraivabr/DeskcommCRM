import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { redirect } from "next/navigation";
import { loadOnboardingState } from "@/app/actions/onboarding/_shared";
import { resumoDoOnboarding } from "@/lib/onboarding/passos";
import { env } from "@/lib/env";
import { oQueMaisExiste } from "@/lib/onboarding/o-que-mais-existe";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { readCommercialAccount } from "@/lib/billing/entitlements";
import { subscriptionView, type SubscriptionSnapshot } from "@/lib/billing/subscription-view";
import { ROLE_RANK } from "@/lib/auth/types";
import { DoneClient } from "./_client";

export const dynamic = "force-dynamic";

export default async function DonePage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/login");

  const { state } = await loadOnboardingState(activeOrg.orgId);

  // O resumo sai da MESMA fonte que decidiu a ordem e desenhou o indicador.
  // Antes era uma terceira lista, fixa, e por isso ela listava "Loja Nuvemshop
  // (pulado)" em instalações que nunca ofereceram esse passo — o wizard
  // acusando a pessoa de não fazer o que ninguém lhe pediu.
  const itens = resumoDoOnboarding(state, { lojaLigada: env.NUVEMSHOP_ENABLED });
  const db = getRequestPool();
  const account = await readCommercialAccount(db, activeOrg.orgId);
  const { rows: [subscription] } = await db.query<SubscriptionSnapshot>(
    "select provider,provider_customer_id,provider_subscription_id,plan_id,status,current_period_end,checkout_session_id,checkout_expires_at from org_subscriptions where organization_id=$1",
    [activeOrg.orgId],
  );
  const needsPlan = !user.support && account.classification === "free_public" &&
    !account.free_enabled && !subscriptionView(subscription).active;

  return <DoneClient itens={itens} pecas={oQueMaisExiste()} needsPlan={needsPlan}
    canChoosePlan={ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin} />;
}
