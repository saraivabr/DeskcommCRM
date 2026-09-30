"use client";
import { useEffect, useState, type ReactNode } from "react";
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

function activityDateLabel(instant: string, now = new Date()) {
  const date = new Date(instant);
  if (date.toDateString() === now.toDateString())
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return date.toLocaleDateString([], {
    day: "2-digit",
    month: "2-digit",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" as const } : {}),
  });
}
const icons: Record<string, typeof Sparkles> = {
  conversations: MessageCircle,
  leads: Filter,
  tasks: Clock,
  "agent-cases": Sparkles,
  "new-conversations": MessageCircle,
  "new-leads": Filter,
  appointments: CalendarDays,
  won: Check,
};
const priority = ["tasks", "agent-cases", "leads", "conversations"];

export function WorkspaceOverview({ assistant }: { assistant?: ReactNode }) {
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
  const attention = data?.attention
    .slice()
    .sort((a, b) => priority.indexOf(a.id) - priority.indexOf(b.id));
  const firstPending = attention?.find((item) => (item.count ?? 0) > 0);
  return (
    <div className={styles.overview} aria-busy={busy}>
      <div className={styles.overviewToolbar}>
        <p>{t("Sua operação, em perspectiva")}</p>
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
          <select
            aria-label={t("Período dos indicadores")}
            value={days}
            disabled={busy}
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
            <RefreshCw size={16} className={busy ? "animate-spin" : ""} aria-hidden />
          </button>
        </div>
      </div>
      <p role="status" className={styles.loadStatus}>
        {busy ? t(data ? "Atualizando sua operação…" : "Consultando sua operação…") : "\u00a0"}
      </p>
      {busy && !data && (
        <div className={styles.metrics} aria-hidden="true">
          {[0, 1, 2, 3].map((key) => (
            <div key={key} className={styles.metricSkeleton}>
              <span />
              <span />
            </div>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {t(error)}
        </p>
      )}
      {data && (
        <section aria-labelledby="home-movement-title">
          <h2 id="home-movement-title" className="sr-only">
            {t("Movimento da operação")}
          </h2>
          <div className={styles.metrics}>
            {data.movement.map((item) => {
              const Icon = icons[item.id] ?? Sparkles;
              return (
                <Link
                  key={item.id}
                  href={item.href}
                  className={styles.metric}
                  title={t(item.description)}
                >
                  <div className={styles.metricTop}>
                    <span>{t(item.label)}</span>
                    <Icon size={18} aria-hidden />
                  </div>
                  <strong>{item.count ?? "—"}</strong>
                  <span className={styles.metricFoot}>
                    {t(item.count === null ? "Consulta indisponível" : "Ver detalhes")}
                    <ArrowRight size={14} aria-hidden />
                  </span>
                </Link>
              );
            })}
          </div>
        </section>
      )}
      <div className={styles.operationGrid}>
        <section className={styles.focusPanel} aria-labelledby="home-attention-title">
          <div className={styles.sectionHead}>
            <div>
              <span className={styles.eyebrow}>{t("PRÓXIMOS PASSOS")}</span>
              <h2 id="home-attention-title">{t("Precisa de você")}</h2>
            </div>
            <Clock size={20} aria-hidden />
          </div>
          {data && (
            <>
              {firstPending && (
                <Link href={firstPending.href} className={styles.nextAction}>
                  {t("Abrir pendência")}: {t(firstPending.label)}
                  <ArrowRight size={16} aria-hidden />
                </Link>
              )}
              <div className={styles.priorityList}>
                {attention?.map((item) => {
                  const Icon = icons[item.id] ?? Sparkles;
                  return (
                    <Link
                      key={item.id}
                      href={item.href}
                      className={styles.priorityRow}
                      data-kind={item.id}
                      title={t(item.description)}
                    >
                      <span className={styles.priorityIcon}>
                        <Icon size={18} aria-hidden />
                      </span>
                      <div>
                        <h3>{t(item.label)}</h3>
                        <span>
                          {t(item.count === null ? "Consulta indisponível" : "Ver detalhes")}
                        </span>
                      </div>
                      <strong>{item.count ?? "—"}</strong>
                      <ArrowRight size={16} aria-hidden />
                      {item.count === null && (
                        <span className="sr-only">
                          {t("Não foi possível consultar. Atualize para tentar novamente.")}
                        </span>
                      )}
                    </Link>
                  );
                })}
              </div>
              <p className={styles.note}>
                {t(
                  (data?.scope ?? scope) === "mine"
                    ? "Registros atualmente atribuídos a você."
                    : "Registros visíveis da equipe.",
                )}
              </p>
            </>
          )}
        </section>
        <section className={styles.activityPanel} aria-labelledby="home-activity-title">
          <div className={styles.sectionHead}>
            <div>
              <span className={styles.eyebrow}>{t("CONVERSAS")}</span>
              <h2 id="home-activity-title">{t("Conversas recentes")}</h2>
            </div>
            <Link
              href={
                (data?.scope ?? scope) === "mine"
                  ? "/app/inbox?filter=mine"
                  : "/app/inbox?filter=all"
              }
              className={styles.quietLink}
            >
              {t("Ver tudo")}
              <ArrowRight size={14} aria-hidden />
            </Link>
          </div>
          {data &&
            (data.activities === null ? (
              <p role="alert" className={styles.status}>
                {t("Não foi possível consultar as atividades. Tente atualizar.")}
              </p>
            ) : data.activities.length ? (
              <div>
                {data.activities.map((item) => (
                  <Link key={item.id} href={item.href} className={styles.activity}>
                    <span className={styles.activityAvatar}>
                      {item.title.trim().slice(0, 1).toLocaleUpperCase()}
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
            ))}
        </section>
        {assistant && <div className={styles.assistantPanel}>{assistant}</div>}
      </div>
      {data && (
        <p className={styles.note}>
          {t("Consultado em")}{" "}
          <time dateTime={data.updatedAt}>{new Date(data.updatedAt).toLocaleString()}</time> ·{" "}
          {t("Indicadores independentes, sem atribuição entre eles.")}
        </p>
      )}
    </div>
  );
}
