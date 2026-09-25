"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import {
  COMMERCIAL_ACCOUNT_CLASSIFICATIONS,
  type CommercialAccount,
  DEFAULT_COMMERCIAL_ACCOUNT,
} from "@/lib/billing/entitlements";
const labels = {
  legacy_unclassified: "Legado — ainda não classificado",
  internal: "Uso interno",
  demo: "Demonstração",
  courtesy: "Cortesia",
  external_contract: "Contrato externo",
  free_public: "Free beta",
  paid: "Assinatura paga",
};
const numberFields = [
  ["free_seats", "Pessoas"],
  ["free_channels", "Canais"],
  ["free_agents", "Funcionários publicados"],
  ["free_ai_credit_cents", "Crédito de IA (centavos de real)"],
  ["free_ai_usd_to_brl_rate", "Tarifa comercial USD → BRL"],
] as const;
export function CommercialAccountCard({ organizationId }: { organizationId: string }) {
  const t = useT();
  const [account, setAccount] = useState<CommercialAccount>(DEFAULT_COMMERCIAL_ACCOUNT);
  const [loadedOrganizationId, setLoadedOrganizationId] = useState<string | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const endpoint = `/api/v1/admin/tenants/${organizationId}/commercial-account`;
  useEffect(() => {
    let active = true;
    fetch(endpoint)
      .then(async (r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then((body) => {
        if (!active) return;
        setAccount(body.data.account);
        setCanEdit(body.data.can_edit);
        setLoadedOrganizationId(organizationId);
      })
      .catch(() => {
        if (active)
          setMessage(t("Não foi possível carregar a classificação. Recarregue a página."));
      });
    return () => {
      active = false;
    };
  }, [endpoint, organizationId, t]);
  function changePeriod(key: "free_period_start" | "free_period_end", value: string) {
    const timestamp = value ? new Date(`${value}Z`) : null;
    if (timestamp && !Number.isFinite(timestamp.getTime())) return;
    setAccount((previous) => ({ ...previous, [key]: timestamp?.toISOString() ?? null }));
  }
  async function save() {
    if (loadedOrganizationId !== organizationId || !canEdit || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(account),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message || t("Não foi possível salvar."));
      setAccount(body.data.account);
      setMessage(t("Classificação salva."));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("Não foi possível salvar."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="space-y-4 rounded-lg border bg-card p-5"
      aria-label={t("Classificação comercial")}
    >
      <h2 className="font-semibold">{t("Classificação comercial")}</h2>
      <p className="text-sm text-muted-foreground">
        {t(
          "IA está em todos os planos. Contas existentes mantêm seu acesso; uma assinatura confirmada tem prioridade sobre esta classificação.",
        )}
      </p>
      <fieldset
        disabled={loadedOrganizationId !== organizationId || !canEdit || busy}
        className="space-y-4"
      >
        <Label htmlFor="commercial-classification">{t("Tipo de conta")}</Label>
        <select
          id="commercial-classification"
          className="h-10 w-full rounded-md border bg-background px-3"
          value={account.classification}
          onChange={(e) =>
            setAccount({
              ...account,
              classification: e.target.value as CommercialAccount["classification"],
              free_enabled: false,
            })
          }
        >
          {COMMERCIAL_ACCOUNT_CLASSIFICATIONS.map((value) => (
            <option key={value} value={value}>
              {t(labels[value])}
            </option>
          ))}
        </select>
        {account.classification === "free_public" && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {t(
                "Beta fechado: configure os limites e o período antes de habilitar. A renovação é manual. Rascunhos e testes não ocupam vaga de funcionário publicado; o consumo de IA usa o mesmo saldo. Nos planos pagos, permanece a contagem atual de funcionários não arquivados.",
              )}
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              {numberFields.map(([key, label]) => (
                <div className="space-y-1" key={key}>
                  <Label htmlFor={key}>{t(label)}</Label>
                  <Input
                    id={key}
                    type="number"
                    min="0"
                    step={key === "free_ai_usd_to_brl_rate" ? "0.01" : "1"}
                    value={account[key] ?? ""}
                    onChange={(e) =>
                      setAccount({
                        ...account,
                        [key]: e.target.value === "" ? null : Number(e.target.value),
                      })
                    }
                  />
                </div>
              ))}
              {(["free_period_start", "free_period_end"] as const).map((key, i) => (
                <div className="space-y-1" key={key}>
                  <Label htmlFor={key}>
                    {t(i === 0 ? "Início do período (UTC)" : "Fim do período (UTC)")}
                  </Label>
                  <Input
                    id={key}
                    type="datetime-local"
                    value={account[key]?.slice(0, 16) ?? ""}
                    onInput={(e) => changePeriod(key, e.currentTarget.value)}
                    onChange={(e) => changePeriod(key, e.currentTarget.value)}
                  />
                </div>
              ))}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={account.free_enabled}
                onChange={(e) => {
                  const enabled = e.currentTarget.checked;
                  setAccount((previous) => ({ ...previous, free_enabled: enabled }));
                }}
              />
              {t("Habilitar Free neste período")}
            </label>
            <p className="text-xs text-muted-foreground">
              {t(
                "Crédito e tarifa ficam registrados ao primeiro uso do período. Alterações posteriores valem para o próximo período; períodos utilizados não podem se sobrepor.",
              )}
            </p>
          </div>
        )}
        <Button type="button" onClick={save}>
          {t(busy ? "Salvando…" : "Salvar classificação")}
        </Button>
      </fieldset>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
    </section>
  );
}
