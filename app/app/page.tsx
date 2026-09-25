import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { readCommercialAccount } from "@/lib/billing/entitlements";
import { subscriptionView, type SubscriptionSnapshot } from "@/lib/billing/subscription-view";
import { ROLE_RANK } from "@/lib/auth/types";
import { WorkspaceHome } from "./_components/WorkspaceHome";
export const dynamic = "force-dynamic";
export default async function AppHome() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  let needsPlan = false;
  if (activeOrg && !user.support) {
    const db = getRequestPool();
    const account = await readCommercialAccount(db, activeOrg.orgId);
    if (account.classification === "free_public" && !account.free_enabled) {
      const { rows: [subscription] } = await db.query<SubscriptionSnapshot>(
        "select provider,provider_customer_id,provider_subscription_id,plan_id,status,current_period_end,checkout_session_id,checkout_expires_at from org_subscriptions where organization_id=$1",
        [activeOrg.orgId],
      );
      needsPlan = !subscriptionView(subscription).active;
    }
  }
  return <WorkspaceHome needsPlan={needsPlan} canChoosePlan={Boolean(activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin)} />;
}
