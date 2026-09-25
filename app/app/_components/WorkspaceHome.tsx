"use client";
import { MessageCircle, PanelsTopLeft, BookOpen } from "lucide-react";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import {
  WorkspaceComposer,
  useWorkspaceAssistant,
} from "@/components/workspace/WorkspaceAssistant";
import { WorkspaceOverview } from "./WorkspaceOverview";

export function WorkspaceHome() {
  const { user, activeOrg } = useAuth();
  return <WorkspaceSession key={`${user.id}:${activeOrg?.orgId}:${activeOrg?.role}`} />;
}
function WorkspaceSession() {
  const t = useT();
  const { activeOrg } = useAuth();
  const { openAssistant, canKnowledge, busy } = useWorkspaceAssistant();
  const suggestions = [
    { icon: MessageCircle, text: "Resuma as conversas recentes", scope: "conversations" as const },
    {
      icon: PanelsTopLeft,
      text: "Quais oportunidades precisam de atenção?",
      scope: "leads" as const,
    },
    ...(canKnowledge
      ? [
          {
            icon: BookOpen,
            text: "Encontre uma informação nos meus conteúdos",
            scope: "knowledge" as const,
          },
        ]
      : []),
  ];
  return (
    <div className="mx-auto w-full max-w-6xl px-1 pt-6 pb-20 sm:px-6 sm:pt-10">
      <p className="mb-7 text-xs text-muted-foreground">{activeOrg?.name ?? t("Seu espaço")}</p>
      <header className="mb-7">
        <h1 className="text-3xl font-semibold tracking-[-0.045em] sm:text-4xl">
          {t("O que vamos resolver hoje?")}
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          {t("Converse com sua operação. Veja o que precisa de você.")}
        </p>
      </header>
      <WorkspaceComposer />
      <div className="mt-4 flex flex-wrap gap-2">
        {suggestions.map(({ icon: Icon, text, scope }) => (
          <button
            key={text}
            disabled={busy}
            type="button"
            onClick={() => openAssistant(text, scope)}
            className="flex min-h-10 items-center gap-2 rounded-full border bg-card px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            <Icon size={15} aria-hidden />
            {t(text)}
          </button>
        ))}
      </div>
      <WorkspaceOverview />
    </div>
  );
}
