"use client";

import {
  createContext,
  useContext,
  useCallback,
  useRef,
  useState,
  type ReactNode,
  type Dispatch,
  type SetStateAction,
} from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowUp, LoaderCircle, Sparkles } from "lucide-react";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { askWorkspace } from "@/app/app/_workspace-action";
import { roleAtLeast } from "@/lib/auth/types";
import type { WorkspaceReply, WorkspaceScope } from "@/lib/workspace/schema";
import { VoiceInput } from "./VoiceInput";

type Turn = { question: string; reply: Extract<WorkspaceReply, { ok: true }>; receivedAt: string };
type Assistant = {
  question: string;
  setQuestion: Dispatch<SetStateAction<string>>;
  scope: WorkspaceScope;
  setScope: (value: WorkspaceScope) => void;
  busy: boolean;
  listening: boolean;
  setListening: (value: boolean) => void;
  canKnowledge: boolean;
  openAssistant: (question?: string, scope?: WorkspaceScope) => void;
  send: () => Promise<void>;
};
const Context = createContext<Assistant | null>(null);
export function useWorkspaceAssistant() {
  const context = useContext(Context);
  if (!context) throw new Error("WorkspaceAssistantProvider is required");
  return context;
}
export function WorkspaceAssistantProvider({ children }: { children: ReactNode }) {
  const { user, activeOrg } = useAuth();
  return (
    <AssistantSession key={`${user.id}:${activeOrg?.orgId}:${activeOrg?.role}`}>
      {children}
    </AssistantSession>
  );
}
function routeScope(path: string): WorkspaceScope {
  if (path.startsWith("/app/inbox")) return "conversations";
  if (path.startsWith("/app/kanban")) return "leads";
  if (path.startsWith("/app/ai/knowledge")) return "knowledge";
  return "all";
}
function AssistantSession({ children }: { children: ReactNode }) {
  const t = useT();
  const pathname = usePathname();
  const { activeOrg } = useAuth();
  const canKnowledge = !!activeOrg && roleAtLeast(activeOrg.role, "manager");
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [scope, setScope] = useState<WorkspaceScope>("all");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  const recording = useRef(false);
  const [listening, setListeningState] = useState(false);
  const setListening = useCallback((value: boolean) => {
    recording.current = value;
    setListeningState(value);
  }, []);
  function openAssistant(text?: string, requestedScope?: WorkspaceScope) {
    const nextScope = requestedScope ?? routeScope(pathname);
    setScope(nextScope === "knowledge" && !canKnowledge ? "all" : nextScope);
    if (text !== undefined) setQuestion(text);
    setOpen(true);
  }
  async function send() {
    const text = question.trim();
    if (!text || sending.current || recording.current) return;
    sending.current = true;
    setBusy(true);
    setOpen(true);
    setError(null);
    try {
      const reply = await askWorkspace({
        question: text,
        scope,
        history: turns.slice(-2).flatMap((turn) => [
          { role: "user", content: turn.question },
          { role: "assistant", content: turn.reply.answer },
        ]),
      });
      if (!reply.ok) {
        setError(reply.message);
        return;
      }
      setTurns((previous) => [
        ...previous,
        { question: text, reply, receivedAt: new Date().toLocaleTimeString() },
      ]);
      setQuestion("");
    } catch {
      setError(t("A conexão falhou. Sua pergunta foi mantida; tente novamente."));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  return (
    <Context.Provider
      value={{
        question,
        setQuestion,
        scope,
        setScope,
        busy,
        listening,
        setListening,
        canKnowledge,
        openAssistant,
        send,
      }}
    >
      <Sheet open={open} onOpenChange={(value) => (value ? openAssistant() : setOpen(false))}>
        {children}
        <SheetContent className="flex w-full flex-col gap-4 sm:max-w-xl">
          <SheetTitle>{t("Escreve aí.")}</SheetTitle>
          <SheetDescription>
            {t("Converse com sua operação. Somente leitura, com suas permissões.")}
          </SheetDescription>
          <div
            className="min-h-0 flex-1 space-y-6 overflow-y-auto"
            role="log"
            aria-label={t("Conversa com seu CRM")}
          >
            {!turns.length && (
              <p className="text-sm text-muted-foreground">
                {t(
                  "Pergunte sobre conversas, oportunidades ou conteúdos. Confira o recorte e as fontes de cada resposta.",
                )}
              </p>
            )}
            {turns.map((turn, index) => (
              <article key={index} className="space-y-3">
                <p className="rounded-xl bg-muted p-3 text-sm whitespace-pre-wrap">
                  {turn.question}
                </p>
                <p className="text-sm leading-7 break-words whitespace-pre-wrap">
                  {turn.reply.answer}
                </p>
                <details className="rounded-xl border p-3 text-xs text-muted-foreground">
                  <summary className="cursor-pointer">
                    {t("Fontes e recorte da consulta")} · {t("Somente leitura")}
                  </summary>
                  <p className="mt-3 leading-5">{turn.reply.notice}</p>
                  <p className="mt-2">
                    {t("Resposta recebida às")} {turn.receivedAt}.{" "}
                    {t("Não acompanha alterações posteriores automaticamente.")}
                  </p>
                  {turn.reply.sources.length ? (
                    <ul className="mt-3 space-y-2" aria-label={t("Fontes consultadas")}>
                      {turn.reply.sources.map((source) => (
                        <li key={source.id}>
                          <Link
                            href={source.href}
                            onClick={() => setOpen(false)}
                            className="inline-block rounded-md p-2 text-primary underline focus-visible:ring-2"
                          >
                            {t(source.kind)} · {source.title}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2">{t("Nenhuma fonte foi encontrada neste recorte.")}</p>
                  )}
                </details>
              </article>
            ))}
            {busy && (
              <p role="status" className="text-sm text-muted-foreground">
                {t("Consultando seu espaço…")}
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <WorkspaceComposer compact />
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setTurns([]);
              setQuestion("");
              setError(null);
            }}
          >
            {t("Nova conversa")}
          </Button>
        </SheetContent>
      </Sheet>
    </Context.Provider>
  );
}
export function WorkspaceAssistantTrigger() {
  const t = useT();
  return (
    <SheetTrigger asChild>
      <Button variant="outline" size="sm">
        <Sparkles size={16} aria-hidden />
        {t("Escreve aí")}
      </Button>
    </SheetTrigger>
  );
}
export function WorkspaceComposer({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const {
    question,
    setQuestion,
    scope,
    setScope,
    busy,
    listening,
    setListening,
    canKnowledge,
    send,
  } = useWorkspaceAssistant();
  return (
    <form
      className="rounded-2xl border bg-card p-4 shadow-sm"
      onSubmit={(event) => {
        event.preventDefault();
        if (!listening) void send();
      }}
    >
      <textarea
        aria-label={t("O que você quer saber sobre seu CRM?")}
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
        disabled={busy}
        maxLength={2000}
        rows={compact ? 2 : 3}
        placeholder={t("Pergunte sobre uma conversa, uma oportunidade ou um conteúdo…")}
        className="w-full resize-none rounded-lg bg-transparent p-1 text-sm leading-6 outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.repeat &&
            !event.nativeEvent.isComposing &&
            event.keyCode !== 229
          ) {
            event.preventDefault();
            if (!listening) void send();
          }
        }}
      />
      <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <select
          aria-label={t("Onde consultar")}
          value={scope}
          disabled={busy}
          onChange={(event) => setScope(event.target.value as WorkspaceScope)}
          className="rounded-lg border bg-background px-2 py-2 text-xs"
        >
          <option value="all">{t("Meu espaço")}</option>
          <option value="conversations">{t("Conversas")}</option>
          <option value="leads">{t("Funil")}</option>
          {canKnowledge && <option value="knowledge">{t("Conteúdos")}</option>}
        </select>
        <VoiceInput
          recordingActive={listening}
          onListeningChange={setListening}
          disabled={busy}
          onTranscript={(text) =>
            setQuestion((current) => `${current}${current ? " " : ""}${text}`.slice(0, 2000))
          }
        />
        <Button
          type="submit"
          size="icon"
          className="rounded-full"
          disabled={busy || listening || !question.trim()}
          aria-label={t(busy ? "Consultando" : "Enviar pergunta")}
        >
          {busy ? (
            <LoaderCircle size={18} className="animate-spin" aria-hidden />
          ) : (
            <ArrowUp size={18} aria-hidden />
          )}
        </Button>
      </div>
      {!compact && (
        <p className="mt-3 text-xs text-muted-foreground">
          {t("Somente leitura. Enter envia; Shift + Enter quebra a linha.")}
        </p>
      )}
    </form>
  );
}
