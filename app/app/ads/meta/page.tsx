/**
 * Análise → Meta Ads. O que a mídia paga está entregando, ao lado do resto da
 * análise, em vez de numa aba separada do Gerenciador de Anúncios.
 *
 * ─── Por que `manager`, e não `viewer` como Desempenho ──────────────────────
 *
 * A vizinha imediata no menu (`/app/metrics`) é aberta a todo mundo porque
 * mostra o funil e a performance de quem atende — e um `agent` vê as PRÓPRIAS
 * pela RLS. Aqui não há recorte por pessoa: orçamento, custo por lead e
 * criativo são da empresa inteira. É o mesmo grau de Evolução da IA e Audit
 * Log, os outros dois vizinhos do grupo, e os dois são `manager`.
 *
 * ─── Por que o token NÃO passa por aqui ─────────────────────────────────────
 *
 * Esta página pergunta apenas SE existe conexão (`existeConexaoDeLeitura`), que
 * não decifra nada. A única forma de garantir que um segredo não chega ao
 * browser é ele não entrar no componente que renderiza HTML — e a tentação de
 * "já que estou lendo a linha, leio o token junto" é exatamente como ele
 * vazaria para um prop de client component.
 */
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { existeConexaoDeLeitura } from "@/lib/plataformas-de-anuncio/credenciais-de-leitura";
import { createAdminClient } from "@/lib/supabase/admin";

import { MetaAdsSource } from "@/components/ads/MetaAdsSource";

export const metadata = { title: "Meta Ads" };
export const dynamic = "force-dynamic";

export default async function MetaAdsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  const admin = createAdminClient();
  const conexao = await existeConexaoDeLeitura(admin, activeOrg.orgId, "meta_ads");

  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);
  // Quem NÃO pode conectar não deve ler "vá em Configurações" — a tela lá é
  // `admin`, e mandar um manager para uma porta que devolve 403 é pior que
  // dizer a verdade: ele precisa pedir para alguém.
  const podeConectar =
    (user.is_platform_admin && !user.support) || ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin;

  return (
    /*
      Superfície clara — mesmo escopo de Desempenho, a vizinha no menu. `-m-6`
      cancela o respiro do `<main>` do AppShell para o Paper alcançar a borda, e
      o `p-6` o repõe.
    */
    <div
      data-superficie="clara"
      className="-m-6 flex min-h-[calc(100%+3rem)] flex-col gap-6 bg-bg p-6 text-text"
    >
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Meta Ads")}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          {t(
            "Escolha a conta, consulte os resultados e prepare campanhas para revisão. Os números vêm da Meta no momento da consulta.",
          )}
        </p>
      </header>

      <MetaAdsSource
        legacyConnected={conexao.conectada}
        defaultAccount={conexao.contaPadrao}
        canConnect={podeConectar}
        language={idioma}
      />
    </div>
  );
}
