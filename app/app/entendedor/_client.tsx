"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";

interface Estado {
  settings: {
    enabled: boolean;
    process_received: boolean;
    process_sent: boolean;
    show_understanding: boolean;
    show_spoken_text: boolean;
  };
  usage: {
    period_start: string;
    renews_on: string;
    used_seconds: number;
    limit_seconds: number;
    audios_understood: number;
    audios_failed: number;
  };
}

type Chave = keyof Estado["settings"];

function minutos(segundos: number): string {
  return String(Math.floor(segundos / 60));
}

function dataCurta(iso: string): string {
  const [ano, mes, dia] = iso.split("-");
  return `${dia}/${mes}/${ano}`;
}

export function EntendedorClient({ podeEditar }: { podeEditar: boolean }) {
  const t = useT();
  const [estado, setEstado] = useState<Estado | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState<Chave | null>(null);

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      const res = await fetch("/api/v1/entendedor", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error?.message ?? "erro");
      setEstado(json.data as Estado);
    } catch {
      setErro(t("Não foi possível carregar o Entendedor de áudio."));
    }
  }, [t]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function mudar(chave: Chave, valor: boolean) {
    if (!estado) return;
    setSalvando(chave);
    setErro(null);
    try {
      const res = await fetch("/api/v1/entendedor", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [chave]: valor }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErro(json?.error?.message ?? t("Não foi possível salvar. Tente novamente."));
        return;
      }
      if (json.data?.usage) setEstado(json.data as Estado);
      else setEstado({ ...estado, settings: { ...estado.settings, [chave]: valor } });
    } catch {
      setErro(t("Não foi possível salvar. Tente novamente."));
    } finally {
      setSalvando(null);
    }
  }

  if (!estado) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-4 p-4 md:p-8">
        {erro ? (
          <Card className="space-y-3 p-6">
            <p className="text-sm text-destructive">{erro}</p>
            <Button variant="outline" onClick={() => void carregar()}>
              {t("Tentar de novo")}
            </Button>
          </Card>
        ) : (
          <>
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-48 w-full" />
          </>
        )}
      </div>
    );
  }

  const { settings, usage } = estado;
  const pct = usage.limit_seconds > 0 ? Math.min(100, Math.round((usage.used_seconds / usage.limit_seconds) * 100)) : 100;
  const esgotou = usage.used_seconds >= usage.limit_seconds;

  const preferencias: Array<{ chave: Chave; titulo: string; texto: string }> = [
    {
      chave: "process_received",
      titulo: t("Áudios que você recebe"),
      texto: t("Quando um contato manda áudio, a nota vai na própria conversa, citando o áudio."),
    },
    {
      chave: "process_sent",
      titulo: t("Áudios que você envia"),
      texto: t("Também explica os áudios que você manda pelo seu WhatsApp."),
    },
    {
      chave: "show_understanding",
      titulo: t("O que importa"),
      texto: t("Uma ou duas frases com o que a pessoa quis dizer."),
    },
    {
      chave: "show_spoken_text",
      titulo: t("O que foi dito"),
      texto: t("O texto da fala, para conferir. Fica recolhido no Ler mais."),
    },
  ];

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-4 md:p-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Entendedor de áudio")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("Chega um áudio no seu WhatsApp e, em segundos, a conversa recebe uma nota curta com o que importa. Você não precisa ouvir para saber do que se trata.")}
        </p>
      </header>

      <Card className="flex items-start justify-between gap-4 p-6">
        <div className="space-y-1">
          <p className="font-medium">{settings.enabled ? t("Ligado") : t("Desligado")}</p>
          <p className="text-sm text-muted-foreground">
            {settings.enabled
              ? t("Os próximos áudios das suas conexões de WhatsApp recebem a nota.")
              : t("Ligue para começar a usar. Você pode desligar quando quiser.")}
          </p>
          {!podeEditar ? (
            <p className="text-xs text-muted-foreground">{t("Só administradores mudam o Entendedor de áudio.")}</p>
          ) : null}
        </div>
        <Switch
          aria-label={t("Ligar o Entendedor de áudio")}
          checked={settings.enabled}
          disabled={!podeEditar || salvando !== null}
          onCheckedChange={(v) => void mudar("enabled", v)}
        />
      </Card>

      <Card className="space-y-3 p-6" data-testid="entendedor-franquia">
        <div className="flex items-baseline justify-between gap-4">
          <p className="font-medium">{t("Minutos grátis deste mês")}</p>
          <p className="text-sm tabular-nums">
            <span className="font-semibold">{minutos(usage.used_seconds)}</span>
            {" / "}
            {minutos(usage.limit_seconds)} {t("min")}
          </p>
        </div>
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <div className={esgotou ? "h-full bg-destructive" : "h-full bg-primary"} style={{ width: `${pct}%` }} />
        </div>
        <p className="text-sm text-muted-foreground">
          {esgotou ? t("Os minutos acabaram. A franquia renova em") : t("A franquia renova em")}{" "}
          {dataCurta(usage.renews_on)}. {t("Áudios entendidos este mês:")} {usage.audios_understood}
        </p>
      </Card>

      <Card className="divide-y p-0">
        {preferencias.map((p) => (
          <div key={p.chave} className="flex items-start justify-between gap-4 p-6">
            <div className="space-y-1">
              <p className="font-medium">{p.titulo}</p>
              <p className="text-sm text-muted-foreground">{p.texto}</p>
            </div>
            <Switch
              aria-label={p.titulo}
              checked={settings[p.chave]}
              disabled={!podeEditar || salvando !== null}
              onCheckedChange={(v) => void mudar(p.chave, v)}
            />
          </div>
        ))}
      </Card>

      {erro ? <p className="text-sm text-destructive" role="alert">{erro}</p> : null}

      <Card className="space-y-2 p-6">
        <p className="font-medium">{t("Ainda não conectou seu WhatsApp?")}</p>
        <p className="text-sm text-muted-foreground">
          {t("Conecte pelo QR Code ou pelo código de pareamento. O Entendedor usa as conexões desta organização.")}
        </p>
        <Button asChild variant="outline">
          <Link href="/app/connections">{t("Ir para Conexões")}</Link>
        </Button>
      </Card>
    </div>
  );
}
