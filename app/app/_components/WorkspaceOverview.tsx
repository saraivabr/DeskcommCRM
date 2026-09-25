"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { getHomeOverview } from "../_home-action";
import type { HomeInput, HomeOverview } from "@/lib/workspace/home";

export function WorkspaceOverview() {
  const t = useT();
  const [scope, setScope] = useState<HomeInput["scope"]>("mine");
  const [days, setDays] = useState<7 | 30>(7);
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<HomeOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    let current = true;
    void getHomeOverview({ scope, days })
      .then((result) => {
        if (!current) return;
        if (result.ok) setData(result.data);
        else {
          setData(null);
          setError(result.message);
        }
      })
      .catch(() => {
        if (current) {
          setData(null);
          setError("A conexão falhou. Tente atualizar novamente.");
        }
      })
      .finally(() => {
        if (current) setBusy(false);
      });
    return () => {
      current = false;
    };
  }, [scope, days, revision]);
  return (
    <div className="mt-12 space-y-8" aria-busy={busy}>
      <section aria-labelledby="home-attention-title">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 id="home-attention-title" className="text-lg font-semibold tracking-tight">
            {t("Precisa de você")}
          </h2>
          <div className="flex items-center gap-2">
            <select
              aria-label={t("Escopo das pendências")}
              value={scope}
              disabled={busy}
              onChange={(event) => {
                setBusy(true);
                setError(null);
                setScope(event.target.value as HomeInput["scope"]);
              }}
              className="h-10 rounded-xl border bg-card px-3 text-sm"
            >
              <option value="mine">{t("Minhas pendências")}</option>
              {data?.canSeeTeam && <option value="team">{t("Ver a equipe")}</option>}
            </select>
            <Button
              variant="ghost"
              size="icon"
              disabled={busy}
              aria-label={t("Atualizar operação")}
              onClick={() => {
                setBusy(true);
                setError(null);
                setRevision((value) => value + 1);
              }}
            >
              <RefreshCw size={16} className={busy ? "animate-spin" : ""} />
            </Button>
          </div>
        </div>
        {busy && (
          <p role="status" className="py-6 text-sm text-muted-foreground">
            {t("Consultando sua operação…")}
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="rounded-xl border border-destructive/30 p-4 text-sm text-destructive"
          >
            {t(error)}
          </p>
        )}
        {!busy && data && (
          <>
            <p className="mb-4 text-xs leading-5 text-muted-foreground">
              {t(
                scope === "mine"
                  ? "Itens atribuídos a você. Registros sem responsável ficam fora desta visão."
                  : "Itens da equipe visíveis com suas permissões.",
              )}
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              {data.attention.map((item) => (
                <Link
                  key={item.id}
                  href={item.href}
                  className="group rounded-2xl border bg-card p-5 transition-colors hover:border-primary/50 focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <div className="mb-4 flex items-center justify-between">
                    <span className="text-3xl font-semibold tracking-tight">
                      {item.count ?? "—"}
                    </span>
                    <ArrowUpRight
                      size={17}
                      className="text-muted-foreground group-hover:text-primary"
                    />
                  </div>
                  <h3 className="text-sm font-medium">{t(item.label)}</h3>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    {t(
                      item.count === null
                        ? "Não foi possível consultar. Atualize para tentar novamente."
                        : item.description,
                    )}
                  </p>
                </Link>
              ))}
            </div>
          </>
        )}
      </section>
      {!busy && data && (
        <div className="grid gap-5 lg:grid-cols-2">
          <section
            aria-labelledby="home-movement-title"
            className="rounded-2xl border bg-card p-5 sm:p-6"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="home-movement-title" className="text-base font-semibold">
                {t("Movimento da operação")}
              </h2>
              <select
                aria-label={t("Período dos indicadores")}
                value={days}
                onChange={(event) => {
                  setBusy(true);
                  setError(null);
                  setDays(Number(event.target.value) as 7 | 30);
                }}
                className="h-10 rounded-lg border bg-background px-2 text-xs"
              >
                <option value={7}>{t("Últimos 7 dias")}</option>
                <option value={30}>{t("Últimos 30 dias")}</option>
              </select>
            </div>
            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              {t(
                scope === "mine"
                  ? "Registros atualmente atribuídos a você. Indicadores independentes, sem atribuição entre eles."
                  : "Registros visíveis da equipe. Indicadores independentes, sem atribuição entre eles.",
              )}
            </p>
            <ul className="mt-4 divide-y">
              {data.movement.map((item) => (
                <li key={item.id}>
                  <Link
                    href={item.href}
                    className="flex items-center justify-between gap-4 py-4 hover:text-primary"
                  >
                    <div>
                      <p className="text-sm font-medium">{t(item.label)}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t(item.count === null ? "Consulta indisponível" : item.description)}
                      </p>
                    </div>
                    <strong className="text-xl tabular-nums">{item.count ?? "—"}</strong>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
          <section
            aria-labelledby="home-activity-title"
            className="rounded-2xl border bg-card p-5 sm:p-6"
          >
            <h2 id="home-activity-title" className="text-base font-semibold">
              {t("Atividade recente")}
            </h2>
            <p className="mt-3 text-xs text-muted-foreground">
              {t("Últimas mensagens nas conversas deste escopo.")}
            </p>
            {data.activities === null ? (
              <p role="alert" className="mt-6 text-sm text-muted-foreground">
                {t("Não foi possível consultar as atividades. Tente atualizar.")}
              </p>
            ) : data.activities.length ? (
              <ul className="mt-4 divide-y">
                {data.activities.map((item) => (
                  <li key={item.id}>
                    <Link
                      href={item.href}
                      className="flex items-center justify-between gap-3 py-4 hover:text-primary"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{item.title}</p>
                        <time
                          dateTime={item.at}
                          className="mt-1 block text-xs text-muted-foreground"
                        >
                          {new Date(item.at).toLocaleString()}
                        </time>
                      </div>
                      <ArrowUpRight size={16} className="shrink-0" />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-6 text-sm text-muted-foreground">
                {t("Nenhuma atividade acessível neste escopo.")}
              </p>
            )}
          </section>
        </div>
      )}
      {!busy && data && (
        <p className="text-xs text-muted-foreground">
          {t("Consultado em")}{" "}
          <time dateTime={data.updatedAt}>{new Date(data.updatedAt).toLocaleString()}</time> ·{" "}
          {t("Atualize para consultar novamente.")}
        </p>
      )}
    </div>
  );
}
