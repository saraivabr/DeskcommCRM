"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  RefreshCw,
  MessageCircle,
  Filter,
  Clock,
  Sparkles,
  CalendarDays,
  Check,
} from "lucide-react";
import { useT } from "@/hooks/i18n/useT";
import styles from "./workspace-home.module.css";
import { getHomeOverview } from "../_home-action";
import type { HomeInput, HomeOverview } from "@/lib/workspace/home";

/** Match the browser-local date used by the full timestamp in the tooltip. */
function activityDateLabel(instant: string, now = new Date()) {
  const date = new Date(instant);
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString([], {
    day: "2-digit",
    month: "2-digit",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" as const } : {}),
  });
}

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
  const iconFor = (id: string) =>
    (
      ({
        conversations: MessageCircle,
        leads: Filter,
        tasks: Clock,
        cases: Sparkles,
        "new-conversations": MessageCircle,
        "new-leads": Filter,
        appointments: CalendarDays,
        won: Check,
      }) as Record<string, typeof Sparkles>
    )[id] ?? Sparkles;
  const attention = data?.attention
    .slice()
    .sort((a, b) => Number(a.id === "tasks") - Number(b.id === "tasks"));
  return (
    <div className={styles.overview} aria-busy={busy}>
      <section aria-labelledby="home-attention-title">
        <div className={styles.sectionHead}>
          <h2 id="home-attention-title">{t("Precisa de você")}</h2>
          <div className={styles.scopeControls}>
            <select
              aria-label={t("Escopo das pendências")}
              value={scope}
              disabled={busy}
              className={styles.period}
              onChange={(event) => {
                setBusy(true);
                setError(null);
                setScope(event.target.value as HomeInput["scope"]);
              }}
            >
              <option value="mine">{t("Minhas pendências")}</option>
              {data?.canSeeTeam && <option value="team">{t("Ver a equipe")}</option>}
            </select>
            <button
              type="button"
              className={styles.refresh}
              disabled={busy}
              aria-label={t("Atualizar operação")}
              onClick={() => {
                setBusy(true);
                setError(null);
                setRevision((value) => value + 1);
              }}
            >
              <RefreshCw size={12} className={busy ? "animate-spin" : ""} aria-hidden />
            </button>
          </div>
        </div>
        {busy && (
          <p role="status" className={styles.status}>
            {t("Consultando sua operação…")}
          </p>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {t(error)}
          </p>
        )}
        {!busy && data && (
          <div className={styles.attention}>
            {attention?.map((item) => {
              const Icon = iconFor(item.id);
              return (
                <Link
                  key={item.id}
                  href={item.href}
                  className={styles.attentionItem}
                  data-kind={item.id}
                  title={t(item.description)}
                >
                  <div className={styles.attentionTop}>
                    <span className={styles.attentionNumber}>{item.count ?? "—"}</span>
                    <Icon aria-hidden />
                  </div>
                  <h3 className={styles.attentionLabel}>{t(item.label)}</h3>
                  <div className={styles.attentionMeta}>
                    <span>{t(item.count === null ? "Consulta indisponível" : "Ver detalhes")}</span>
                    <ArrowRight aria-hidden />
                  </div>
                  {item.count === null && (
                    <span className="sr-only">
                      {t("Não foi possível consultar. Atualize para tentar novamente.")}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        )}
      </section>
      {!busy && data && (
        <div className={styles.lower}>
          <section aria-labelledby="home-movement-title">
            <div className={styles.sectionHead}>
              <div>
                <h2 id="home-movement-title">{t("Movimento da operação")}</h2>
                <p className={styles.sectionSub}>
                  {t("Atividades no período, sem atribuição entre elas.")}
                </p>
              </div>
              <select
                aria-label={t("Período dos indicadores")}
                value={days}
                className={styles.period}
                onChange={(event) => {
                  setBusy(true);
                  setError(null);
                  setDays(Number(event.target.value) as 7 | 30);
                }}
              >
                <option value={7}>{t("Últimos 7 dias")}</option>
                <option value={30}>{t("Últimos 30 dias")}</option>
              </select>
            </div>
            <div>
              {data.movement.map((item) => {
                const Icon = iconFor(item.id);
                return (
                  <Link
                    key={item.id}
                    href={item.href}
                    className={styles.stat}
                    title={t(item.count === null ? "Consulta indisponível" : item.description)}
                  >
                    <span className={styles.statLabel}>
                      <Icon aria-hidden />
                      {t(item.label)}
                    </span>
                    <strong>{item.count ?? "—"}</strong>
                  </Link>
                );
              })}
            </div>
            <p className={styles.note}>
              {t(
                scope === "mine"
                  ? "Registros atualmente atribuídos a você. Indicadores independentes, sem atribuição entre eles."
                  : "Registros visíveis da equipe. Indicadores independentes, sem atribuição entre eles.",
              )}
            </p>
          </section>
          <section aria-labelledby="home-activity-title">
            <div className={styles.sectionHead}>
              <div>
                <h2 id="home-activity-title">{t("Acontecendo agora")}</h2>
                <p className={styles.sectionSub}>
                  {t("Últimas mensagens nas conversas deste escopo.")}
                </p>
              </div>
              <Link
                href={scope === "mine" ? "/app/inbox?filter=mine" : "/app/inbox?filter=all"}
                className={styles.quietLink}
              >
                {t("Ver tudo")}
                <ArrowRight aria-hidden />
              </Link>
            </div>
            {data.activities === null ? (
              <p role="alert" className={styles.status}>
                {t("Não foi possível consultar as atividades. Tente atualizar.")}
              </p>
            ) : data.activities.length ? (
              <div>
                {data.activities.map((item) => (
                  <Link key={item.id} href={item.href} className={styles.activity}>
                    <span className={styles.activityIcon}>
                      <MessageCircle aria-hidden />
                    </span>
                    <div className={styles.activityCopy}>
                      <strong>{item.title}</strong>
                      <p>{t("Conversa atualizada")}</p>
                    </div>
                    <time dateTime={item.at} title={new Date(item.at).toLocaleString()}>
                      {activityDateLabel(item.at)}
                    </time>
                  </Link>
                ))}
              </div>
            ) : (
              <p className={styles.status}>{t("Nenhuma atividade acessível neste escopo.")}</p>
            )}
          </section>
        </div>
      )}
      {!busy && data && (
        <p className={styles.note}>
          {t("Consultado em")}{" "}
          <time dateTime={data.updatedAt}>{new Date(data.updatedAt).toLocaleString()}</time> ·{" "}
          {t("Atualize para consultar novamente.")}
        </p>
      )}
    </div>
  );
}
