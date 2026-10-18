"use client";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Providers } from "@/app/providers";
import { resetRealtimeAuthentication } from "@/lib/supabase/browser";
import { apiClient } from "@/lib/api/client";
import type { AuthUser, ActiveOrg, Role } from "@/lib/auth/types";
import { ROLE_RANK } from "@/lib/auth/types";

interface AuthCtx {
  user: AuthUser;
  activeOrg: ActiveOrg | null;
  isAuthenticated: true;
  refreshing: boolean;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({
  user,
  activeOrg,
  children,
}: {
  user: AuthUser;
  activeOrg: ActiveOrg | null;
  children: ReactNode;
}) {
  const [refreshing, setRefreshing] = useState(false);

  // Invalida o token do Realtime quando o CONTEXTO acaba — troca de usuário,
  // organização ou acompanhamento, e desmontagem. É a limpeza que faz isso: ela
  // roda antes de cada troca de dependência e ao desmontar.
  //
  // O corpo NÃO zera mais na primeira montagem. Efeitos rodam do filho para o
  // pai, então os canais (`useRealtimeChannel`) já tinham pedido
  // `/api/v1/auth/realtime-token` quando este efeito zerava a época: a resposta
  // em voo era descartada, os seis canais caíam em `channel_error`, assinavam de
  // novo 1 s depois (segunda ida ao token) e o "reassinado" disparava mais uma
  // checagem de `/api/v1/auth/interface`. Medido em produção em 2026-10-18: duas
  // chamadas ao token por página aberta. Na primeira montagem não há contexto
  // anterior para invalidar — o de uma montagem anterior já foi zerado pela
  // limpeza dela.
  useEffect(
    () => resetRealtimeAuthentication,
    [user.id, activeOrg?.orgId, user.support?.id, user.support?.access_mode],
  );

  // Revogação/scope no banco também derrubam o snapshot aberto de UI/realtime.
  useEffect(() => {
    if (!user.support) return;
    const expected = `${user.support.id}:${user.support.access_mode}:${user.support.status}`;
    const check = async () => {
      const response = await fetch("/api/v1/auth/support", { cache: "no-store" }).catch(() => null);
      if (!response?.ok) return;
      const result = await response.json();
      if (result.data.signature !== expected) window.location.reload();
    };
    const timer = setInterval(() => { void check(); }, 15000);
    return () => clearInterval(timer);
  }, [user.support]);

  // O browser não lê o cookie HttpOnly: refreshSession() local sempre ficava
  // sem sessão. A mesma origem permite ao proxy/servidor renovar o cookie.
  useEffect(() => {
    const controller = new AbortController();
    let checking = false;
    let lastCheck = Date.now();
    const check = async () => {
      if (checking || document.visibilityState === "hidden" || Date.now() - lastCheck < 5 * 60_000) return;
      checking = true;
      lastCheck = Date.now();
      setRefreshing(true);
      try {
        await apiClient.get("/api/v1/auth/session", { signal: controller.signal });
      } catch {
        // 401 real já encaminha ao login no apiClient. Indisponibilidade não
        // apaga a sessão; o próximo intervalo/retorno à aba tenta novamente.
      } finally {
        checking = false;
        if (!controller.signal.aborted) setRefreshing(false);
      }
    };
    const interval = setInterval(() => { void check(); }, 5 * 60_000);
    document.addEventListener("visibilitychange", check);
    return () => {
      controller.abort();
      clearInterval(interval);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);

  const value = useMemo<AuthCtx>(
    () => ({
      user,
      activeOrg,
      isAuthenticated: true,
      refreshing,
      signOut: async () => {
        resetRealtimeAuthentication();
        const { signOut } = await import("@/app/actions/auth/signOut");
        await signOut();
      },
    }),
    [user, activeOrg, refreshing],
  );

  return <Ctx.Provider value={value}>
    <Providers key={`${user.id}:${activeOrg?.orgId ?? "none"}:${user.support?.id ?? "normal"}:${user.support?.access_mode ?? ""}`}>{children}</Providers>
  </Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

export function useUser(): AuthUser {
  return useAuth().user;
}

export function useActiveOrg(): ActiveOrg | null {
  return useAuth().activeOrg;
}

/**
 * Permission gate based on role rank. Action mapping is intentionally
 * minimal here — feature-specific gates can extend with custom logic.
 */
const ACTION_MIN_ROLE: Record<string, Role> = {
  "inbox.view": "viewer",
  "inbox.reply": "agent",
  "inbox.claim": "agent",
  "contact.view": "viewer",
  "contact.create": "agent",
  "contact.update": "agent",
  "contact.delete": "manager",
  "pipeline.view": "viewer",
  "pipeline.create": "manager",
  "pipeline.move_card": "agent",
  "team.invite": "admin",
  "team.change_role": "admin",
  "settings.write": "admin",
  "lgpd.execute_redact": "admin",
  "audit.view": "manager",
  "ai.automatico.view": "agent",
  "ai.inbox.view": "agent",
  "inbox.notes.view": "agent",
  // O cartão da passagem, dentro da conversa. `agent` e não `viewer` porque é o
  // piso que a policy de `passagens_de_atendimento` exige (migration 0291): o
  // briefing diz MAIS que a conversa — diz o que a IA concluiu sobre a pessoa.
  // Um `viewer` que sondasse esta rota levaria 403 em toda abertura de conversa.
  "inbox.passagens.view": "agent",
  "message-templates.view": "agent",
  "ai.agents.view": "manager",
  "ai.agents.write": "admin",
  "ai.memory.view": "manager",
  "ai.memory.publish": "admin",
  "ai.skills.view": "manager",
  "ai.skills.manage": "manager",
  "ai.routers.view": "manager",
  "ai.evolution.view": "manager",
  "ai.routers.manage": "admin",
  "ai.credentials.view": "manager",
  "ai.credentials.write": "admin",
  "webhooks.manage": "manager",
  // Mesmo mínimo de lib/navigation/catalogo.ts (destino /app/calls) e de
  // requireRole("manager") em app/api/v1/calls/route.ts — a RLS de crm_calls
  // é só por organização, então sem este gate o aviso ao vivo de ligação
  // chegaria pra viewer/agent, papéis que a tela nunca mostra pra eles.
  "calls.view": "manager",
  // Chamada de voz (spec 18). `agent` porque ligar e atender é ato de
  // atendimento, não de configuração — e porque é o piso que as rotas de
  // `app/api/v1/voice/calls/*` exigem. Quem não alcança este piso (viewer, e
  // acompanhamento administrativo somente-leitura, que é rebaixado a viewer em
  // `resolveActiveOrg`) não sonda, não assina e não vê telefone tocar: um
  // banner de chamada para quem não pode atendê-la é uma promessa falsa, e a
  // sondagem por trás dele levava 403 em toda navegação.
  "voice.call": "agent",
};

export function usePermission(action: string): boolean {
  const { user, activeOrg } = useAuth();
  if (user.is_platform_admin && !user.support) return true;
  if (!activeOrg) return false;
  const required = ACTION_MIN_ROLE[action];
  if (!required) return false;
  return ROLE_RANK[activeOrg.role] >= ROLE_RANK[required];
}
