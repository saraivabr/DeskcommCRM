"use client";
import { useEffect, useState } from "react";
import { BarChart3, Sparkles, Filter } from "lucide-react";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { useWorkspaceAssistant } from "@/components/workspace/WorkspaceAssistant";
import Link from "next/link";
import { WorkspaceOverview } from "./WorkspaceOverview";
import { HomeComposer } from "./HomeComposer";
import styles from "./workspace-home.module.css";

export function WorkspaceHome({ needsPlan = false, canChoosePlan = false }: { needsPlan?: boolean; canChoosePlan?: boolean }) {
  const { user, activeOrg } = useAuth();
  return <WorkspaceSession key={`${user.id}:${activeOrg?.orgId}:${activeOrg?.role}`} needsPlan={needsPlan} canChoosePlan={canChoosePlan} />;
}
function WorkspaceSession({ needsPlan, canChoosePlan }: { needsPlan: boolean; canChoosePlan: boolean }) {
  const t = useT();
  const { user } = useAuth();
  const firstName = user.full_name?.trim().split(/\s+/)[0];
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
            ? `${t(now.getHours() < 12 ? "Bom dia" : now.getHours() < 18 ? "Boa tarde" : "Boa noite")}${firstName ? `, ${firstName}` : ""}.`
            : "\u00a0"}
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
        <h1 className={styles.heading}>{t(needsPlan ? "Seu espaço está pronto." : "O que vamos resolver hoje?")}</h1>
        <p className={styles.subtitle}>
          {t(needsPlan ? "A IA está incluída em todos os planos. Ative o acesso para começar." : "Converse com sua operação. Veja o que precisa de você.")}
        </p>
      </header>
      {needsPlan ? (
        <section className="mt-8 rounded-2xl border bg-card p-6" aria-label={t("Ativar acesso")}>
          <p className="text-sm text-muted-foreground">
            {t(canChoosePlan
              ? "Escolha Essencial, Crescer ou Escala. Seu acesso começa após a confirmação do pagamento."
              : "O responsável pela empresa precisa escolher um plano para liberar o acesso.")}
          </p>
          {canChoosePlan && (
            <Link href="/app/settings/billing" className="mt-4 inline-flex rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
              {t("Ver planos e contratar")}
            </Link>
          )}
        </section>
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}
