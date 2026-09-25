"use client";
import { useEffect, useState } from "react";
import { BarChart3, Sparkles, Filter } from "lucide-react";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { useWorkspaceAssistant } from "@/components/workspace/WorkspaceAssistant";
import { WorkspaceOverview } from "./WorkspaceOverview";
import { HomeComposer } from "./HomeComposer";
import styles from "./workspace-home.module.css";

export function WorkspaceHome() {
  const { user, activeOrg } = useAuth();
  return <WorkspaceSession key={`${user.id}:${activeOrg?.orgId}:${activeOrg?.role}`} />;
}
function WorkspaceSession() {
  const t = useT();
  const { user } = useAuth();
  const { openAssistant, busy } = useWorkspaceAssistant();
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => setNow(new Date()), 0);
    return () => window.clearTimeout(timer);
  }, []);
  const suggestions = [
    { icon: BarChart3, text: "Resuma o dia", scope: "all" as const },
    { icon: Sparkles, text: "O que precisa de atenção?", scope: "all" as const },
    { icon: Filter, text: "Onde perdemos oportunidades?", scope: "leads" as const },
  ];
  return (
    <div className={styles.home}>
      <div className={styles.welcome}>
        <span>
          {now
            ? t(now.getHours() < 12 ? "Bom dia" : now.getHours() < 18 ? "Boa tarde" : "Boa noite")
            : "\u00a0"}
          {now ? `${user.full_name ? `, ${user.full_name.split(" ")[0]}` : ""}.` : ""}
        </span>
        <span className={styles.date}>
          {now?.toLocaleDateString(user.idioma, {
            weekday: "long",
            day: "numeric",
            month: "long",
          })}
        </span>
      </div>
      <header>
        <h1 className={styles.heading}>{t("O que vamos resolver hoje?")}</h1>
        <p className={styles.subtitle}>
          {t("Converse com sua operação. Veja o que precisa de você.")}
        </p>
      </header>
      <HomeComposer />
      <div className={styles.suggestions}>
        {suggestions.map(({ icon: Icon, text, scope }) => (
          <button
            key={text}
            disabled={busy}
            type="button"
            onClick={() => openAssistant(text, scope)}
            className={styles.suggestion}
          >
            <Icon aria-hidden />
            {t(text)}
          </button>
        ))}
      </div>
      <WorkspaceOverview />
    </div>
  );
}
