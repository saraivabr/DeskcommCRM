"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import type { Idioma } from "@/lib/i18n/idiomas";
import { MetaAdsClient } from "@/app/app/ads/meta/_components/MetaAdsClient";
import { MetaNativeAdsClient } from "./MetaNativeAdsClient";

export function MetaAdsSource({
  legacyConnected,
  defaultAccount,
  canConnect,
  language,
}: {
  legacyConnected: boolean;
  defaultAccount: string | null;
  canConnect: boolean;
  language: Idioma;
}) {
  const t = useT();
  const [source, setSource] = useState<"native" | "legacy">("native");
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2" role="group" aria-label={t("Fonte da autorização")}>
        <Button
          variant={source === "native" ? "default" : "outline"}
          aria-pressed={source === "native"}
          onClick={() => setSource("native")}
        >
          {t("Conexão Meta")}
        </Button>
        <Button
          variant={source === "legacy" ? "default" : "outline"}
          aria-pressed={source === "legacy"}
          onClick={() => setSource("legacy")}
        >
          {t("Token manual")}
        </Button>
      </div>
      {source === "native" ? (
        <MetaNativeAdsClient />
      ) : legacyConnected ? (
        <>
          <p className="text-sm text-muted-foreground">
            {t("Esta leitura usa o token manual guardado nas configurações da empresa.")}
          </p>
          <MetaAdsClient contaPadrao={defaultAccount} idioma={language} />
        </>
      ) : (
        <div className="rounded-md border p-5 text-sm">
          <p className="font-medium">{t("Nenhum token manual conectado.")}</p>
          {canConnect ? (
            <a href="/app/settings/meta-ads" className="mt-3 inline-block underline">
              {t("Configurar token manual")}
            </a>
          ) : (
            <p className="mt-2 text-muted-foreground">
              {t("Peça a quem administra a empresa para configurar o acesso.")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
