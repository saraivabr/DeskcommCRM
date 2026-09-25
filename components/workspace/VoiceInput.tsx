"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";

type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type VoiceWindow = Window & {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
};

/** Browser-managed dictation. Never starts on mount and never submits a question. */
export function VoiceInput({
  disabled,
  recordingActive,
  onTranscript,
  onListeningChange,
}: {
  disabled: boolean;
  recordingActive: boolean;
  onTranscript: (text: string) => void;
  onListeningChange: (value: boolean) => void;
}) {
  const t = useT();
  const recognition = useRef<Recognition | null>(null);
  const [listening, setListening] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(
    () => () => {
      if (recognition.current) {
        recognition.current.onresult = null;
        recognition.current.onerror = null;
        recognition.current.onend = null;
        recognition.current.abort();
        recognition.current = null;
        onListeningChange(false);
      }
    },
    [onListeningChange],
  );
  function start() {
    if (recognition.current) {
      recognition.current.stop();
      return;
    }
    const Constructor =
      (window as VoiceWindow).SpeechRecognition ?? (window as VoiceWindow).webkitSpeechRecognition;
    if (!Constructor) {
      setNotice(
        t("A entrada por voz não está disponível neste navegador. Você pode digitar sua pergunta."),
      );
      return;
    }
    const session = new Constructor();
    session.lang = "pt-BR";
    session.interimResults = false;
    session.continuous = false;
    session.onresult = (event) => {
      const text = Array.from(event.results)
        .map((result) => result[0]?.transcript ?? "")
        .join(" ")
        .trim();
      if (text) {
        onTranscript(text);
        setNotice(t("Texto transcrito. Revise a pergunta antes de enviar."));
      }
    };
    session.onerror = () =>
      setNotice(
        t("Não foi possível transcrever. Confira a permissão do microfone ou digite sua pergunta."),
      );
    session.onend = () => {
      recognition.current = null;
      setListening(false);
      onListeningChange(false);
    };
    recognition.current = session;
    try {
      session.start();
      setListening(true);
      onListeningChange(true);
      setNotice(t("Ouvindo. A transcrição ficará no campo para você revisar."));
    } catch {
      recognition.current = null;
      setListening(false);
      onListeningChange(false);
      setNotice(t("Não foi possível iniciar o microfone. Você pode digitar sua pergunta."));
    }
  }
  return (
    <div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled || (recordingActive && !listening)}
        onClick={start}
        aria-pressed={listening}
        title={t(
          "Transcrever pelo navegador; o serviço de voz do navegador pode processar o áudio.",
        )}
      >
        {listening ? <Square size={16} aria-hidden /> : <Mic size={16} aria-hidden />}
        {t(listening ? "Parar gravação" : "Falar")}
      </Button>
      {notice && (
        <p role="status" className="mt-2 max-w-72 text-xs text-muted-foreground">
          {notice}
        </p>
      )}
    </div>
  );
}
