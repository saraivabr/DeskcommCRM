"use client";
import { ArrowUp, LoaderCircle, ShieldCheck } from "lucide-react";
import { useT } from "@/hooks/i18n/useT";
import { useWorkspaceAssistant } from "@/components/workspace/WorkspaceAssistant";
import { VoiceInput } from "@/components/workspace/VoiceInput";
import styles from "./workspace-home.module.css";

/** The Home and drawer use the same draft, request lock and conversation. */
export function HomeComposer() {
  const t = useT();
  const { question, setQuestion, busy, listening, setListening, send } = useWorkspaceAssistant();
  return (
    <form
      className={styles.composer}
      onSubmit={(event) => {
        event.preventDefault();
        if (!listening) void send("all");
      }}
    >
      <textarea
        aria-label={t("O que você quer saber sobre seu CRM?")}
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
        disabled={busy}
        maxLength={2000}
        rows={2}
        placeholder={t("Pergunte sobre sua operação...")}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.repeat &&
            !event.nativeEvent.isComposing &&
            event.keyCode !== 229
          ) {
            event.preventDefault();
            if (!listening) void send("all");
          }
        }}
      />
      <div className={styles.composeBottom}>
        <span className={styles.context}>
          <ShieldCheck aria-hidden />
          {t("Seu espaço, com suas permissões")}
        </span>
        <div className={styles.voice}>
          <VoiceInput
            recordingActive={listening}
            onListeningChange={setListening}
            disabled={busy}
            onTranscript={(text) =>
              setQuestion((current) => `${current}${current ? " " : ""}${text}`.slice(0, 2000))
            }
          />
        </div>
        <button
          type="submit"
          className={styles.send}
          disabled={busy || listening || !question.trim()}
          aria-label={t(busy ? "Consultando" : "Enviar pergunta")}
        >
          {busy ? <LoaderCircle className="animate-spin" aria-hidden /> : <ArrowUp aria-hidden />}
        </button>
      </div>
    </form>
  );
}
