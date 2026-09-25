import { caktoConfiguration } from "@/lib/billing/cakto";
import { AiAllowanceCard } from "@/components/billing/AiAllowanceCard";
import {
  readAiAllowance,
  readAiUsageBreakdown,
  type AiAllowanceView,
} from "@/lib/billing/ai-allowance-view";
import { billingConfiguration } from "@/lib/billing/stripe";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { ManageSubscriptionButton } from "@/components/billing/ManageSubscriptionButton";
import { subscriptionView, type SubscriptionSnapshot } from "@/lib/billing/subscription-view";
import { AiUsageBreakdown } from "@/components/billing/AiUsageBreakdown";
import { readCommercialAccount } from "@/lib/billing/entitlements";
import { FreeBetaCard, type FreeBetaAccount } from "@/components/billing/FreeBetaCard";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { emailDeSuporte } from "@/lib/branding/saida";
import { PlanComparison } from "@/components/billing/PlanComparison";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

/**
 * A tela de dinheiro entregava o nosso contato ao cliente do revendedor, e ela
 * tem porta de 1ª classe no menu. Mesmo tratamento da tela de conta suspensa:
 * o endereço é o de quem opera a instalação (`SUPPORT_EMAIL`) e, sem ele
 * configurado, nenhum endereço aparece.
 */
export default async function BillingPage() {
  // spec 13 §4: billing é admin-only (viewer/agent/manager = none).
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg || ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    redirect("/403");
  }
  let view: ReturnType<typeof subscriptionView> | null = null;
  let loadFailed = false;
  let allowance: AiAllowanceView | null = null;
  let allowanceFailed = false;
  let billingEnabled = false;
  let freeBeta: FreeBetaAccount | null = null;
  let usage: Awaited<ReturnType<typeof readAiUsageBreakdown>> | null = null;
  let usageFailed = false;
  try {
    if (process.env.BILLING_PROVIDER === "cakto") {
      if (process.env.BILLING_ENABLED !== "true") throw new Error("disabled");
      caktoConfiguration();
    } else billingConfiguration();
    billingEnabled = true;
  } catch {
    /* Unconfigured installations keep the informative catalogue. */
  }
  if (!user.support) {
    try {
      const {
        rows: [subscription],
      } = await getRequestPool().query<SubscriptionSnapshot>(
        "select provider,provider_customer_id,provider_subscription_id,plan_id,status,current_period_end,cancel_at_period_end,checkout_session_id,checkout_expires_at from org_subscriptions where organization_id=$1",
        [activeOrg.orgId],
      );
      view = subscriptionView(subscription);
      if (!subscription?.provider_subscription_id) {
        const account = await readCommercialAccount(getRequestPool(), activeOrg.orgId);
        freeBeta = account.classification === "free_public" ? account : null;
      }
      if (subscription?.provider_subscription_id || freeBeta) {
        try {
          allowance = await readAiAllowance(getRequestPool(), activeOrg.orgId);
          if (allowance) {
            try {
              usage = await readAiUsageBreakdown(getRequestPool(), activeOrg.orgId);
            } catch {
              usageFailed = true;
            }
          }
        } catch {
          allowanceFailed = true;
        }
      }
    } catch {
      loadFailed = true;
    }
  }
  const suporte = await emailDeSuporte();
  const idioma = user.idioma;
  // Dynamic server page: sample once per request; clients receive a stable timestamp.
  // eslint-disable-next-line react-hooks/purity
  const checkedAt = Date.now();
  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          {traduzir("Planos e assinatura", idioma)}
        </h1>
        <p className="text-sm text-muted-foreground">
          {traduzir("Planos, faturas e cobrança.", idioma)}
        </p>
      </header>
      {freeBeta && <FreeBetaCard account={freeBeta} idioma={idioma} now={checkedAt} />}
      {view && !freeBeta && (
        <section
          className="space-y-3 rounded-2xl border bg-card p-5"
          aria-label={traduzir("Sua assinatura", idioma)}
        >
          {view.plan && <p className="font-medium">{traduzir(view.plan.name, idioma)}</p>}
          <p>{traduzir(view.message, idioma)}</p>
          <p className="text-sm text-muted-foreground">
            {traduzir(
              "O estado é atualizado após a confirmação do provedor. Voltar do pagamento não confirma a assinatura.",
              idioma,
            )}
          </p>
          <a href="/app/settings/billing" className="text-sm underline">
            {traduzir("Atualizar estado da assinatura", idioma)}
          </a>
        </section>
      )}
      {allowance && <AiAllowanceCard balance={allowance} idioma={idioma} />}
      {usage && <AiUsageBreakdown usage={usage} idioma={idioma} />}
      {usageFailed && (
        <p role="alert">
          {traduzir(
            "Não foi possível detalhar o consumo de IA. Atualize a página para tentar novamente.",
            idioma,
          )}
        </p>
      )}
      {allowanceFailed && (
        <p role="alert">
          {traduzir(
            "Não foi possível consultar o saldo de IA. Atualize a página para tentar novamente.",
            idioma,
          )}
        </p>
      )}
      {billingEnabled && view?.canManage && <ManageSubscriptionButton idioma={idioma} />}
      {view?.caktoBound && (
        <a
          className="text-sm underline"
          href="https://ajuda.cakto.com.br/pt-br/articles/108-como-cancelar-uma-assinatura-na-cakto"
          target="_blank"
          rel="noreferrer"
        >
          Como solicitar o cancelamento da assinatura na Cakto
        </a>
      )}
      {loadFailed && (
        <p role="alert">
          {traduzir(
            "Não foi possível consultar sua assinatura. Atualize a página para tentar novamente.",
            idioma,
          )}
        </p>
      )}
      <PlanComparison
        idioma={idioma}
        allowedPlanIds={view?.allowedPlanIds ?? []}
        billingEnabled={billingEnabled}
      />
      {suporte ? (
        <p className="text-sm text-muted-foreground">
          {traduzir("Para questões de pagamento, contate", idioma)}{" "}
          <a className="underline" href={`mailto:${suporte}`}>
            {suporte}
          </a>
          .
        </p>
      ) : null}
    </div>
  );
}
