"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useActiveOrg } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { apiClient } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { NativeAccountsDTO, NativeCampaignsDTO } from "@/lib/ads/types";
import { TabelaDeCampanhas } from "@/app/app/ads/meta/_components/TabelaDeCampanhas";
import { AdCampaignDrafts } from "./AdCampaignDrafts";

function initialDates() {
  const to = new Date(Date.now() - 86400000);
  const from = new Date(to.getTime() - 6 * 86400000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

export function MetaNativeAdsClient() {
  const t = useT();
  const languageTag = useTagDeIdioma();
  const org = useActiveOrg();
  const [selected, setSelected] = useState("");
  const [dates, setDates] = useState(initialDates);
  const [lastCompleteDay] = useState(() => initialDates().to);
  const [prepare, setPrepare] = useState(false);
  const accounts = useQuery({
    queryKey: ["ads", "native", "accounts", org?.orgId],
    queryFn: () =>
      apiClient.get<{ data: NativeAccountsDTO }>("/api/v1/ads/meta/accounts?source=native"),
    retry: false,
    staleTime: 60000,
    refetchOnWindowFocus: false,
  });
  const account = accounts.data?.data.accounts.find(
    (a) => `${a.connection_id}:${a.asset_id}` === selected,
  );
  // A pessoa escolhe a conta e pede a leitura; renderizações não consomem cota Graph.
  const campaigns = useQuery({
    queryKey: ["ads", "native", "campaigns", org?.orgId, selected, dates],
    queryFn: () => {
      if (!account) throw new Error(t("Escolha uma conta de anúncios."));
      const query = new URLSearchParams({
        source: "native",
        asset_id: account.asset_id,
        connection_id: account.connection_id,
        ...dates,
      });
      return apiClient.get<{ data: NativeCampaignsDTO }>(`/api/v1/ads/meta/campaigns?${query}`, {
        timeoutMs: 60000,
      });
    },
    enabled: false,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const error = accounts.error ?? campaigns.error;
  return (
    <section className="space-y-5" aria-label={t("Anúncios pela conexão Meta")}>
      <p className="text-sm text-muted-foreground">
        {t(
          "Consulte as contas escolhidas em Conexões. Cada leitura usa a autorização dessa conta.",
        )}
      </p>
      {accounts.isLoading && <p role="status">{t("Carregando contas…")}</p>}
      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm"
        >
          {error instanceof Error ? error.message : t("Não foi possível ler os anúncios.")}
          <a href="/app/connections?aba=sociais" className="mt-2 block underline">
            {t("Conferir autorização em Conexões")}
          </a>
        </div>
      )}
      {accounts.data?.data.accounts.length === 0 && (
        <div className="rounded-md border p-5 text-sm">
          <p className="font-medium">{t("Escolha uma conta de anúncios em Conexões")}</p>
          <p className="mt-1 text-muted-foreground">
            {t("A conta precisa estar selecionada e permitir a leitura de anúncios.")}
          </p>
          <a href="/app/connections?aba=sociais" className="mt-3 inline-block underline">
            {t("Abrir Conexões")}
          </a>
        </div>
      )}
      {Boolean(accounts.data?.data.accounts.length) && (
        <>
          <form
            className="grid gap-3 sm:flex sm:flex-wrap sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              if (account && !campaigns.isFetching) void campaigns.refetch();
            }}
          >
            <div className="min-w-0 space-y-1.5 sm:min-w-[16rem] sm:flex-1">
              <Label htmlFor="native-ad-account">{t("Conta de anúncios")}</Label>
              <select
                id="native-ad-account"
                className="h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm"
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
              >
                <option value="">{t("Escolha a conta")}</option>
                {accounts.data?.data.accounts.map((a) => (
                  <option
                    key={`${a.connection_id}:${a.asset_id}`}
                    value={`${a.connection_id}:${a.asset_id}`}
                  >
                    {a.name} · {a.currency ?? t("Moeda indisponível")}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="native-ads-from">{t("De")}</Label>
              <Input
                id="native-ads-from"
                type="date"
                value={dates.from}
                max={dates.to}
                onChange={(e) => setDates((old) => ({ ...old, from: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="native-ads-to">{t("Até")}</Label>
              <Input
                id="native-ads-to"
                type="date"
                value={dates.to}
                min={dates.from}
                max={lastCompleteDay}
                onChange={(e) => setDates((old) => ({ ...old, to: e.target.value }))}
              />
            </div>
            <Button
              type="submit"
              className="w-full sm:w-auto"
              disabled={
                !account ||
                campaigns.isFetching ||
                !dates.from ||
                !dates.to ||
                dates.from > dates.to
              }
            >
              {campaigns.isFetching ? t("Consultando…") : t("Consultar campanhas")}
            </Button>
          </form>
          {account && (
            <p className="text-xs text-muted-foreground">
              {account.name} · {account.currency ?? t("Moeda indisponível")} ·{" "}
              {account.timezone ?? t("Fuso indisponível")} ·{" "}
              {account.capabilities.ads_manage
                ? t("Leitura e criação autorizadas")
                : t("Somente leitura autorizada")}
            </p>
          )}
        </>
      )}
      {account?.capabilities.ads_manage && (
        <Button type="button" variant="outline" onClick={() => setPrepare((value) => !value)}>
          {prepare ? t("Fechar rascunhos") : t("Preparar campanha")}
        </Button>
      )}
      {account?.capabilities.ads_manage && prepare && (
        <AdCampaignDrafts account={account} key={selected} />
      )}
      {campaigns.data && !campaigns.error && (
        <>
          <TabelaDeCampanhas
            linhas={campaigns.data.data.campanhas}
            moeda={campaigns.data.data.currency ?? "XXX"}
            avisos={campaigns.data.data.avisos}
          />
          <p className="text-xs text-muted-foreground">
            {t("Período")}: {campaigns.data.data.periodo.from} {t("a")}{" "}
            {campaigns.data.data.periodo.to} · {t("lido em")}{" "}
            {new Date(campaigns.data.data.lido_em).toLocaleString(languageTag)}
          </p>
        </>
      )}
    </section>
  );
}
