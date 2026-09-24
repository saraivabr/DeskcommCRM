"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import Image from "next/image";
import {
  InstagramLogo,
  Sparkle,
  Plus,
  Lightning,
  ChatCircleDots,
  Users,
  Copy,
  Check,
  ArrowsClockwise,
  ArrowRight,
  Tag,
  CheckCircle,
  Eye,
  Lightbulb,
} from "@phosphor-icons/react";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { Button } from "@/components/ui/button";
import { ArtisanIcon } from "@/components/brand/ArtisanIcon";
import { StudioShell, Loading, Notice, useItems } from "./_shared";
import type { StudioItem } from "@/lib/instagram/schema";

interface GrowthTrigger {
  id: string;
  name: string;
  post_id: string | null;
  keywords: string[];
  match_mode: string;
  dm_response_template: string;
  auto_create_lead: boolean;
  executions_count: number;
  leads_generated_count: number;
  is_active: boolean;
}

export function InstagramHome() {
  const t = useT();
  const locale = useTagDeIdioma();
  const { items, loading, error, canCreate, reload } = useItems();
  const [triggers, setTriggers] = useState<GrowthTrigger[]>([]);
  const [loadingGrowth, setLoadingGrowth] = useState(true);
  const [postFilter, setPostFilter] = useState<"all" | "ready" | "generating">("all");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expandedCaptionId, setExpandedCaptionId] = useState<string | null>(null);

  // Carregar dados de Automações & Growth
  useEffect(() => {
    let active = true;
    async function loadGrowth() {
      try {
        const res = await fetch("/api/v1/growth/instagram");
        if (!res.ok) return;
        const data = await res.json();
        if (active && data.triggers) {
          setTriggers(data.triggers);
        }
      } catch {
        // Silencioso em caso de erro de rede
      } finally {
        if (active) setLoadingGrowth(false);
      }
    }
    loadGrowth();
    return () => {
      active = false;
    };
  }, []);

  const posts = items.filter((i) => i.kind === "post");
  const filteredPosts = posts.filter((p) => {
    if (postFilter === "ready") return p.status === "ready";
    if (postFilter === "generating") return p.status === "generating";
    return true;
  });

  const totalDms = triggers.reduce((acc, tr) => acc + (tr.executions_count || 0), 0);
  const totalLeads = triggers.reduce((acc, tr) => acc + (tr.leads_generated_count || 0), 0);
  const activeTriggersCount = triggers.filter((tr) => tr.is_active).length;

  const handleCopyCaption = async (id: string, caption: string) => {
    if (!caption) return;
    try {
      await navigator.clipboard.writeText(caption);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2500);
    } catch {
      // Ignora falha de permissão no clipboard
    }
  };

  const getFormatLabel = (input: StudioItem["input"]) => {
    if (input.kind !== "post") return t("Post");
    if (input.format === "story") return t("Story (9:16)");
    if (input.format === "square") return t("Quadrado (1:1)");
    return t("Vertical (4:5)");
  };

  return (
    <StudioShell>
      {/* Hero Principal Unificado */}
      <section className="relative overflow-hidden rounded-3xl border border-border bg-gradient-to-br from-card via-card to-muted/40 p-6 sm:p-10 shadow-xs">
        <div className="relative z-10 flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-2xl space-y-4">
            <div className="inline-flex items-center gap-2 rounded-full border border-pink-500/20 bg-gradient-to-r from-pink-500/10 via-purple-500/10 to-amber-500/10 px-3 py-1 text-xs font-semibold text-foreground">
              <span className="flex h-2 w-2 rounded-full bg-pink-500 animate-pulse" />
              <InstagramLogo size={15} weight="bold" className="text-pink-500" />
              {t("Central Integrada de Instagram")}
            </div>
            <h1 className="font-serif text-3xl font-normal tracking-tight sm:text-4xl lg:text-5xl text-foreground">
              {t("Crie posts com IA e converta comentários em vendas.")}
            </h1>
            <p className="text-base leading-relaxed text-muted-foreground">
              {t(
                "A inteligência artificial cria suas imagens e legendas em segundos. Enquanto isso, o motor de Growth responde comentários de Reels e Posts via DM instantânea e cadastra leads no CRM.",
              )}
            </p>
            <div className="flex flex-wrap items-center gap-3 pt-2">
              <Button asChild size="lg" className="gap-2 shadow-sm">
                <Link href="/app/instagram/new">
                  <Sparkle size={18} weight="fill" />
                  {t("Criar postagem com IA")}
                </Link>
              </Button>
              <Button asChild variant="outline" size="lg" className="gap-2">
                <Link href="/app/instagram/growth">
                  <Lightning size={18} weight="bold" className="text-amber-500" />
                  {t("Automações de Comentários")}
                </Link>
              </Button>
              <Button asChild variant="ghost" size="lg" className="gap-2">
                <Link href="/app/instagram/insights">
                  <Eye size={18} />
                  {t("Ver resultados da conta")}
                </Link>
              </Button>
            </div>
          </div>

          {/* Card Ilustrativo Flutuante */}
          <div className="relative mx-auto flex w-full max-w-xs shrink-0 flex-col items-center justify-center lg:mx-0">
            <div className="relative flex w-64 flex-col rounded-2xl border border-border bg-card p-5 shadow-lg">
              <div className="flex items-center justify-between border-b pb-3">
                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-tr from-amber-500 via-pink-500 to-purple-600 text-white shadow-xs">
                    <InstagramLogo size={18} weight="bold" />
                  </div>
                  <div>
                    <p className="text-xs font-semibold leading-tight">{t("Seu Instagram")}</p>
                    <p className="text-[10px] text-muted-foreground">{t("Motor de Vendas Ativo")}</p>
                  </div>
                </div>
                <span className="flex h-2 w-2 rounded-full bg-emerald-500" />
              </div>
              <div className="space-y-2 py-3 text-xs">
                <div className="rounded-lg bg-muted/60 p-2.5">
                  <p className="font-medium text-foreground">💬 Comentário no Reel:</p>
                  <p className="text-muted-foreground italic">"EU QUERO o link!"</p>
                </div>
                <div className="rounded-lg border border-primary/20 bg-primary/5 p-2.5">
                  <p className="font-medium text-primary">⚡ DM Automática disparada:</p>
                  <p className="line-clamp-2 text-muted-foreground text-[11px]">
                    "Olá! Aqui está o link que você pediu..."
                  </p>
                </div>
              </div>
              <div className="flex items-center justify-between rounded-xl bg-emerald-500/10 px-3 py-2 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                <span className="flex items-center gap-1.5">
                  <CheckCircle size={14} weight="fill" />
                  {t("Lead gerado no Funil")}
                </span>
                <span className="font-bold">+1 lead</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Linha de KPIs e Métricas da Matriz */}
      <section className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <div className="flex flex-col justify-between rounded-2xl border border-border bg-card p-4 sm:p-5 shadow-xs">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs sm:text-sm font-medium">{t("Criações no Estúdio")}</span>
            <Sparkle size={18} className="text-purple-500" />
          </div>
          <div className="mt-2 flex items-baseline justify-between">
            <span className="text-2xl sm:text-3xl font-bold tracking-tight">{posts.length}</span>
            <Link
              href="/app/instagram/library"
              className="text-xs text-muted-foreground hover:underline"
            >
              {t("Ver todas")}
            </Link>
          </div>
        </div>

        <div className="flex flex-col justify-between rounded-2xl border border-border bg-card p-4 sm:p-5 shadow-xs">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs sm:text-sm font-medium">{t("Gatilhos Ativos")}</span>
            <Lightning size={18} className="text-amber-500" />
          </div>
          <div className="mt-2 flex items-baseline justify-between">
            <span className="text-2xl sm:text-3xl font-bold tracking-tight">
              {loadingGrowth ? "…" : activeTriggersCount}
            </span>
            <Link
              href="/app/instagram/growth"
              className="text-xs text-muted-foreground hover:underline"
            >
              {t("Gerenciar")}
            </Link>
          </div>
        </div>

        <div className="flex flex-col justify-between rounded-2xl border border-border bg-card p-4 sm:p-5 shadow-xs">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs sm:text-sm font-medium">{t("DMs Disparadas")}</span>
            <ChatCircleDots size={18} className="text-blue-500" />
          </div>
          <div className="mt-2 flex items-baseline justify-between">
            <span className="text-2xl sm:text-3xl font-bold tracking-tight">
              {loadingGrowth ? "…" : totalDms}
            </span>
            <span className="text-xs text-muted-foreground">{t("automáticas")}</span>
          </div>
        </div>

        <div className="flex flex-col justify-between rounded-2xl border border-border bg-card p-4 sm:p-5 shadow-xs">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs sm:text-sm font-medium">{t("Leads Gerados")}</span>
            <Users size={18} className="text-emerald-500" />
          </div>
          <div className="mt-2 flex items-baseline justify-between">
            <span className="text-2xl sm:text-3xl font-bold tracking-tight text-emerald-600 dark:text-emerald-400">
              {loadingGrowth ? "…" : totalLeads}
            </span>
            <Link href="/app/kanban" className="text-xs text-muted-foreground hover:underline">
              {t("Ver no CRM")}
            </Link>
          </div>
        </div>
      </section>

      {/* Destaque Principal: Últimas Postagens */}
      <section className="space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-border pb-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-serif text-2xl sm:text-3xl font-normal text-foreground">
                {t("Últimas Postagens")}
              </h2>
              {posts.length > 0 && (
                <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-semibold text-muted-foreground">
                  {posts.length}
                </span>
              )}
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              {t("Seus criativos, artes e legendas gerados para o Instagram.")}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Filtros rápidos */}
            <div className="flex rounded-lg border border-border bg-muted/40 p-1 text-xs">
              <button
                type="button"
                onClick={() => setPostFilter("all")}
                className={`rounded-md px-3 py-1.5 font-medium transition ${postFilter === "all" ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"}`}
              >
                {t("Todas")}
              </button>
              <button
                type="button"
                onClick={() => setPostFilter("ready")}
                className={`rounded-md px-3 py-1.5 font-medium transition ${postFilter === "ready" ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"}`}
              >
                {t("Prontas")}
              </button>
              <button
                type="button"
                onClick={() => setPostFilter("generating")}
                className={`rounded-md px-3 py-1.5 font-medium transition ${postFilter === "generating" ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"}`}
              >
                {t("Em geração")}
              </button>
            </div>

            <Button asChild variant="outline" size="sm">
              <Link href="/app/instagram/library" className="gap-1.5">
                {t("Ver todas na biblioteca")}
                <ArrowRight size={14} />
              </Link>
            </Button>
          </div>
        </div>

        {loading ? (
          <Loading />
        ) : error ? (
          <Notice error>
            {error}{" "}
            <button onClick={() => void reload()} className="underline font-medium">
              {t("Tentar novamente")}
            </button>
          </Notice>
        ) : filteredPosts.length > 0 ? (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {filteredPosts.slice(0, 6).map((item) => {
              const brief = item.input.kind === "post" ? item.input.brief : "Criação";
              const isReady = item.status === "ready";
              const isGenerating = item.status === "generating";
              const isCopied = copiedId === item.id;
              const isCaptionExpanded = expandedCaptionId === item.id;

              return (
                <div
                  key={item.id}
                  className="group flex flex-col justify-between overflow-hidden rounded-3xl border border-border bg-card shadow-xs transition hover:shadow-md hover:border-primary/30"
                >
                  {/* Cabeçalho do Card */}
                  <div className="flex items-center justify-between border-b border-border/60 bg-muted/20 px-4 py-3 text-xs">
                    <span className="font-medium text-muted-foreground">
                      {getFormatLabel(item.input)}
                    </span>
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-medium ${
                        isReady
                          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                          : isGenerating
                            ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 animate-pulse"
                            : "bg-destructive/10 text-destructive"
                      }`}
                    >
                      {isReady && <CheckCircle size={12} weight="fill" />}
                      {isGenerating && <ArrowsClockwise size={12} className="animate-spin" />}
                      {isReady
                        ? t("Pronta")
                        : isGenerating
                          ? t("Gerando imagem…")
                          : t("Requer atenção")}
                    </span>
                  </div>

                  {/* Pré-visualização da Imagem */}
                  <Link
                    href={`/app/instagram/posts/${item.id}`}
                    className="relative block aspect-[4/5] w-full overflow-hidden bg-muted/30 focus-visible:outline-2"
                  >
                    {item.image_url ? (
                      <Image
                        unoptimized
                        width={1024}
                        height={1280}
                        src={item.image_url}
                        alt={brief}
                        className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
                      />
                    ) : (
                      <div className="flex h-full w-full flex-col items-center justify-center p-6 text-center">
                        <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                          <ArtisanIcon symbol="instagram" className="h-8 w-8" />
                        </div>
                        <p className="text-sm font-medium text-foreground">
                          {isGenerating
                            ? t("A IA está desenhando sua imagem…")
                            : item.status === "failed"
                              ? t("Não foi possível gerar a imagem")
                              : t("Imagem temporariamente indisponível")}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {isGenerating
                            ? t("Atualiza automaticamente quando pronta")
                            : t("Clique para conferir os detalhes")}
                        </p>
                      </div>
                    )}

                    {/* Overlay sutil ao passar o mouse */}
                    {item.image_url && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition group-hover:opacity-100">
                        <span className="inline-flex items-center gap-2 rounded-full bg-background/90 px-4 py-2 text-xs font-semibold text-foreground shadow-md backdrop-blur-xs">
                          <Eye size={16} />
                          {t("Abrir e Revisar")}
                        </span>
                      </div>
                    )}
                  </Link>

                  {/* Conteúdo / Briefing e Legenda */}
                  <div className="flex flex-1 flex-col justify-between p-4 space-y-3">
                    <div className="space-y-1.5">
                      <Link
                        href={`/app/instagram/posts/${item.id}`}
                        className="line-clamp-2 text-sm font-medium hover:underline text-foreground"
                      >
                        {brief}
                      </Link>
                      <p className="text-[11px] text-muted-foreground">
                        {new Date(item.created_at).toLocaleDateString(locale, {
                          day: "numeric",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </p>
                    </div>

                    {/* Legenda do Post */}
                    {item.caption && (
                      <div className="rounded-xl border border-border/80 bg-muted/30 p-2.5 text-xs text-muted-foreground">
                        <p className={isCaptionExpanded ? "" : "line-clamp-2"}>"{item.caption}"</p>
                        {item.caption.length > 90 && (
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedCaptionId(isCaptionExpanded ? null : item.id)
                            }
                            className="mt-1 font-medium text-foreground underline text-[11px]"
                          >
                            {isCaptionExpanded ? t("Recolher") : t("Ver legenda inteira")}
                          </button>
                        )}
                      </div>
                    )}

                    {/* Barra de Ações Rápidas */}
                    <div className="flex items-center justify-between border-t border-border/60 pt-3 gap-2">
                      {item.caption ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => handleCopyCaption(item.id, item.caption)}
                          className="h-8 gap-1.5 px-2 text-xs"
                        >
                          {isCopied ? (
                            <>
                              <Check size={14} className="text-emerald-500" />
                              <span className="text-emerald-600 font-medium">{t("Copiada!")}</span>
                            </>
                          ) : (
                            <>
                              <Copy size={14} />
                              <span>{t("Copiar Legenda")}</span>
                            </>
                          )}
                        </Button>
                      ) : (
                        <div />
                      )}

                      <div className="flex items-center gap-1.5">
                        <Button asChild variant="outline" size="sm" className="h-8 text-xs">
                          <Link href={`/app/instagram/posts/${item.id}`}>{t("Revisar")}</Link>
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          /* Empty State Inspirador com Ideias Prontas */
          <div className="rounded-3xl border border-dashed border-border bg-card/60 p-8 sm:p-12 text-center space-y-6">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
              <Sparkle size={28} className="text-purple-500" />
            </div>
            <div className="max-w-md mx-auto space-y-2">
              <h3 className="font-serif text-2xl font-normal text-foreground">
                {t("Sua primeira criação começa aqui.")}
              </h3>
              <p className="text-sm text-muted-foreground">
                {canCreate
                  ? t(
                      "Conte em poucas palavras o que sua empresa quer anunciar e a IA cuidará da imagem e da legenda.",
                    )
                  : t("Peça acesso de criação à equipe ou explore ideias inspiradoras abaixo.")}
              </p>
            </div>

            {canCreate && (
              <div className="pt-2">
                <Button asChild size="lg" className="gap-2">
                  <Link href="/app/instagram/new">
                    <Plus size={18} weight="bold" />
                    {t("Criar minha primeira postagem")}
                  </Link>
                </Button>
              </div>
            )}

            {/* Sugestões em 1 Clique */}
            <div className="border-t border-border pt-8">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">
                {t("Ou comece rápido com uma destas ideias:")}
              </p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 text-left">
                <Link
                  href="/app/instagram/new?brief=Post%20chamativo%20anunciando%20uma%20condição%20especial%20exclusiva%20para%20seguidores%20com%20chamada%20para%20comentar%20EU%20QUERO"
                  className="rounded-2xl border border-border bg-card p-4 transition hover:border-primary/40 hover:bg-muted/30"
                >
                  <span className="text-xl">🚀</span>
                  <h4 className="mt-2 text-sm font-semibold text-foreground">
                    {t("Oferta ou Lançamento")}
                  </h4>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t(
                      "Condição especial para seguidores com chamada para comentar 'EU QUERO' e receber DM.",
                    )}
                  </p>
                </Link>

                <Link
                  href="/app/instagram/new?brief=3%20dicas%20valiosas%20e%20práticas%20para%20o%20cliente%20resolver%20uma%20dúvida%20comum%20do%20nosso%20setor"
                  className="rounded-2xl border border-border bg-card p-4 transition hover:border-primary/40 hover:bg-muted/30"
                >
                  <span className="text-xl">💡</span>
                  <h4 className="mt-2 text-sm font-semibold text-foreground">
                    {t("Dica de Especialista")}
                  </h4>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("Post educativo ensinando como resolver um problema frequente do seu cliente.")}
                  </p>
                </Link>

                <Link
                  href="/app/instagram/new?brief=Depoimento%20e%20resultado%20real%20de%20um%20cliente%20satisfeito%20gerando%20confiança%20e%20prova%20social"
                  className="rounded-2xl border border-border bg-card p-4 transition hover:border-primary/40 hover:bg-muted/30"
                >
                  <span className="text-xl">🤝</span>
                  <h4 className="mt-2 text-sm font-semibold text-foreground">
                    {t("Prova Social")}
                  </h4>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("Destaque um resultado real de cliente que comprou e amou a experiência.")}
                  </p>
                </Link>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Seção Integrada de Automações & Growth */}
      <section className="rounded-3xl border border-border bg-card p-6 sm:p-8 space-y-6 shadow-xs">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-border pb-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Lightning size={22} weight="bold" className="text-amber-500" />
              <h2 className="font-serif text-2xl font-normal text-foreground">
                {t("Automações de Comentários & Vendas")}
              </h2>
            </div>
            <p className="text-sm text-muted-foreground">
              {t(
                "Responda automaticamente quem comenta nos seus posts com mensagens no direct e gere leads no CRM.",
              )}
            </p>
          </div>
          <Button asChild size="sm" className="gap-2">
            <Link href="/app/instagram/growth">
              <Plus size={16} weight="bold" />
              {t("Nova Regra de Comentário")}
            </Link>
          </Button>
        </div>

        {loadingGrowth ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {t("Carregando automações de Instagram…")}
          </div>
        ) : triggers.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border p-8 text-center">
            <div className="mb-3 rounded-full bg-muted p-3 text-muted-foreground">
              <ChatCircleDots size={28} />
            </div>
            <h3 className="text-base font-semibold">{t("Nenhuma regra de automação ativa")}</h3>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              {t(
                'Configure gatilhos para palavras como "EU QUERO", "PREÇO" ou "AULA" e envie seu link de vendas ou agendamento automaticamente por DM.',
              )}
            </p>
            <Button asChild size="sm" className="mt-4 gap-2">
              <Link href="/app/instagram/growth">
                <Plus size={16} weight="bold" />
                {t("Criar Primeiro Gatilho")}
              </Link>
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {triggers.slice(0, 3).map((trigger) => (
              <div
                key={trigger.id}
                className="flex flex-col justify-between rounded-2xl border border-border bg-muted/20 p-4 transition hover:bg-muted/40"
              >
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-sm line-clamp-1">{trigger.name}</span>
                    <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-600">
                      {t("Ativo")}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Tag size={13} />
                    <span>{t("Palavras:")}</span>
                    <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                      {trigger.keywords.slice(0, 3).join(", ")}
                    </span>
                  </div>
                  <p className="line-clamp-2 text-xs italic text-muted-foreground">
                    "{trigger.dm_response_template}"
                  </p>
                </div>
                <div className="mt-3 flex items-center justify-between border-t border-border/60 pt-2 text-xs">
                  <span className="font-medium text-foreground">
                    {trigger.executions_count} DMs · {trigger.leads_generated_count} Leads
                  </span>
                  <Link
                    href="/app/instagram/growth"
                    className="text-xs text-primary hover:underline"
                  >
                    {t("Editar")}
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Atalhos Rápidos no Rodapé */}
      <section className="grid gap-4 sm:grid-cols-2">
        <Link
          href="/app/instagram/inspirations"
          className="group flex items-start gap-4 rounded-3xl border border-border bg-card p-6 shadow-xs transition hover:border-primary/40 hover:bg-muted/20"
        >
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-600 dark:text-amber-400">
            <Lightbulb size={24} weight="bold" />
          </div>
          <div className="space-y-1">
            <h3 className="font-serif text-xl font-normal text-foreground group-hover:text-primary transition">
              {t("Sem ideia do que postar? ↗")}
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {t("Pesquise referências de outros perfis e temas em alta para o seu segmento.")}
            </p>
          </div>
        </Link>

        <Link
          href="/app/instagram/insights"
          className="group flex items-start gap-4 rounded-3xl border border-border bg-card p-6 shadow-xs transition hover:border-primary/40 hover:bg-muted/20"
        >
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-blue-500/10 text-blue-600 dark:text-blue-400">
            <Eye size={24} weight="bold" />
          </div>
          <div className="space-y-1">
            <h3 className="font-serif text-xl font-normal text-foreground group-hover:text-primary transition">
              {t("Métricas & Desempenho ↗")}
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {t(
                "Acompanhe o alcance, visualizações e pessoas que interagiram na sua conta conectada.",
              )}
            </p>
          </div>
        </Link>
      </section>
    </StudioShell>
  );
}
