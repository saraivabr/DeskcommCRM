"use client";
import { useCallback, useEffect, useRef } from "react";
import { useT } from "@/hooks/i18n/useT";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { lerInterface } from "@/lib/navigation/interface";
import type { ActiveOrg } from "@/lib/auth/types";
const isDocumentHidden = () => document.visibilityState === "hidden";
/** Invalidação apenas: refresh RSC preserva estado de formulários e URL aberta. */
export function InterfaceRefresh({
  userId,
  org,
  support,
}: {
  userId: string;
  org: ActiveOrg | null;
  support: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const expected = JSON.stringify(lerInterface(org?.interface_settings).settings);
  const epoch = useRef(0);
  const inFlight = useRef(false);
  const pending = useRef(false);
  useEffect(() => {
    const generation = ++epoch.current;
    inFlight.current = false;
    pending.current = false;
    return () => {
      epoch.current = generation + 1;
    };
  }, [userId, org?.orgId, support]);
  const orgId = org?.orgId ?? null;
  const check = useCallback(async () => {
    if (!orgId || support || isDocumentHidden()) return;
    if (inFlight.current) {
      pending.current = true;
      return;
    }
    const generation = epoch.current;
    inFlight.current = true;
    try {
      do {
        pending.current = false;
        try {
          const response = await fetch("/api/v1/auth/interface", { cache: "no-store" });
          if (response.ok) {
            const result = await response.json();
            if (generation !== epoch.current) return;
            if (result.data?.organization_id === orgId && result.data.signature !== expected) {
              router.refresh();
              toast.info(t("Sua navegação foi atualizada. Você pode continuar nesta tela."), {
                id: "interface-updated",
              });
            }
          }
        } catch {
          /* Poll/foco/reconexão repetem leitura, sem trocar contexto por falha. */
        }
        // Uma invalidação pode chegar depois do snapshot lido pela consulta em voo.
        // Consome-a em nova leitura, sem esperar o polling ou aceitar payload como estado.
      } while (generation === epoch.current && pending.current && !isDocumentHidden());
    } finally {
      if (generation === epoch.current) {
        inFlight.current = false;
        pending.current = false;
      }
    }
    // `orgId` e não `org`: o objeto chega novo a cada refresh RSC e derrubava e
    // remontava o intervalo e os ouvintes abaixo sem nada ter mudado.
  }, [orgId, support, expected, router, t]);
  useRealtimeChannel({
    name: `interface:${userId}:${org?.orgId}`,
    enabled: !!org && !support,
    postgresChanges: {
      event: "UPDATE",
      table: "user_organizations",
      filter: `user_id=eq.${userId}`,
    },
    onChange: () => {
      void check();
    },
  });
  useEffect(() => {
    // A mudança chega pelo canal Realtime acima; o relógio e os eventos de
    // retorno são REDE DE SEGURANÇA (canal caído, aba dormindo). A 30 s, e com
    // `focus` e `visibilitychange` disparando juntos na volta à aba (duas
    // leituras: a segunda virava `pending`), eram 4+ idas a
    // `/api/v1/auth/interface` em 45 s numa tela parada — cada uma pagando a
    // verificação de acesso inteira. Medido em produção em 2026-10-18.
    //
    // Gatilhos que chegam juntos viram uma leitura só: a janela de 1 s
    // colapsa `focus` + `visibilitychange` + `online` no mesmo retorno.
    let agendada: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (agendada !== undefined) return;
      agendada = setTimeout(() => {
        agendada = undefined;
        void check();
      }, 1_000);
    };
    const timer = setInterval(refresh, 120_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearTimeout(agendada);
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [check]);
  return null;
}
