"use client";
import Link from "next/link";
import { formatCents, MOEDA_PADRAO } from "@/lib/money";
import { useCallback, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useT } from "@/hooks/i18n/useT";
import { useBoard } from "@/hooks/kanban/useBoard";

function formatError(err: unknown, t: (texto: string) => string): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const obj = err as { message?: unknown; code?: unknown; details?: unknown; hint?: unknown };
    if (typeof obj.message === "string") {
      const code = typeof obj.code === "string" ? ` [${obj.code}]` : "";
      return `${obj.message}${code}`;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return t("Erro desconhecido");
    }
  }
  return String(err);
}
import { KanbanBoard } from "@/components/kanban/KanbanBoard";
import { FilterBar } from "@/components/kanban/FilterBar";
import { BulkActionBar } from "@/components/kanban/BulkActionBar";
import { NewLeadDialog } from "@/components/kanban/NewLeadDialog";
import { Button } from "@/components/ui/button";
import { Plus } from "@/lib/ui/icons";
import type { LeadFilters } from "@/lib/kanban/filters";
import { applyFilters, filtersFromParams, filtersToParams } from "@/lib/kanban/filters";

export function PipelinePageClient({
  pipelineId,
  initialName,
}: {
  pipelineId: string;
  initialName: string;
}) {
  const t = useT();
  const { data, isLoading, error, pulses, realtimeStatus, seguranca } = useBoard(pipelineId);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = useMemo(() => filtersFromParams(searchParams), [searchParams]);
  const setFilters = useCallback(
    (next: LeadFilters) => {
      const qs = filtersToParams(next);
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname],
  );
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [newOpen, setNewOpen] = useState(false);

  const filteredLeads = data ? applyFilters(data.leads, filters) : [];
  const openLeads = filteredLeads.filter((lead) => lead.status === "open");
  const amounts = new Map<string, number>();
  for (const lead of openLeads) {
    if (lead.value_cents == null) continue;
    const currency = lead.currency || MOEDA_PADRAO;
    amounts.set(currency, (amounts.get(currency) ?? 0) + lead.value_cents);
  }
  const openValue = [...amounts]
    .map(([currency, cents]) => formatCents(cents, currency))
    .join(" · ");
  const hasActiveFilters = Boolean(filtersToParams(filters));
  // NÃO é a conta do FilterBar: o seletor de filtro lista as três caixas
  // (`marcadoresDoCard`: negócio, contato e conversa), e esta lista, a da tag em
  // lote, só `lead.tags` — é lá que a ação em lote grava (#852). O `useMemo` é o
  // mesmo cuidado de lá: solta no corpo, a conta roda em toda renderização
  // e devolve um array NOVO a cada vez. E esta página re-renderiza a cada tecla
  // da busca (o debounce do FilterBar mexe na query string) e a cada mudança de
  // seleção de card.
  const tagsDoQuadro = useMemo(
    () => [...new Set((data?.leads ?? []).flatMap((l) => l.tags))].sort(),
    [data?.leads],
  );

  return (
    <div
      className="workspace-pipeline flex h-full min-h-0 flex-col gap-4"
      // OBSERVÁVEL de propósito, e é a razão de existir desta linha: "a
      // assinatura morreu" e "nada aconteceu" produzem o MESMO silêncio na
      // tela, e sem este valor nem o produto nem o teste conseguem separar as
      // duas famílias de causa. Com ele, quem investiga olha DURANTE a rodada
      // que falha: `subscribed` manda procurar a montante (entrega, filtro, ou
      // o evento nunca saiu); `channel_error`/`timed_out`/`closed` já é a
      // resposta.
      //
      // Ainda NÃO religa — religar é desenho e merece bloco próprio. Isto aqui
      // é só parar de descartar o que já era calculado.
      data-realtime-status={realtimeStatus.toLowerCase()}
      // A rede de segurança fica OBSERVÁVEL pelo mesmo motivo do status do
      // canal: "a entrega morreu" e "nada aconteceu" têm a mesma aparência, que
      // é silêncio. Aqui o número de divergências é a diferença entre os dois —
      // e é o sinal que faltava para uma verificação poder APROVAR, e não só
      // reprovar.
      data-refetch-divergencias={seguranca.divergencias}
      data-refetch-em={seguranca.ultimaVerificacao ?? ""}
    >
      {/* `flex-col` no mobile: nome de funil comprido (é texto livre, sem
          limite curto) + botão na mesma linha sem quebra empurrava o botão pra
          fora da viewport em telas estreitas. De `sm:` pra cima volta a ser
          uma linha só, como sempre foi. */}
      <header className="workspace-pipeline-header">
        <div className="min-w-0">
          <Link href="/app/kanban?view=manage" className="workspace-pipeline-back">
            {t("Todos os funis")} ↗
          </Link>
          <h1 className="truncate text-3xl font-semibold tracking-tight">
            {data?.pipeline.name ?? initialName}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("Da primeira conversa ao negócio fechado.")}
          </p>
        </div>
        <Button onClick={() => setNewOpen(true)} disabled={!data} className="shrink-0">
          <Plus size={16} className="mr-2" /> {t("Novo Lead")}
        </Button>
      </header>
      <section className="workspace-pipeline-summary" aria-label={t("Resumo do funil")}>
        <div>
          <span>{t("Em negociação")}</span>
          <strong>{data ? openLeads.length : "—"}</strong>
        </div>
        <div>
          <span>{t("Valor em aberto")}</span>
          <strong>{data ? openValue || "—" : "—"}</strong>
        </div>
        <div>
          <span>{t("Negócios ganhos")}</span>
          <strong>
            {data ? filteredLeads.filter((lead) => lead.status === "won").length : "—"}
          </strong>
        </div>
        <div>
          <span>{t("Etapas")}</span>
          <strong>{data ? data.stages.length : "—"}</strong>
        </div>
      </section>
      {data && (
        <NewLeadDialog
          open={newOpen}
          onOpenChange={setNewOpen}
          pipelineId={pipelineId}
          stages={data.stages}
        />
      )}
      <FilterBar filters={filters} onChange={setFilters} leads={data?.leads ?? []} />
      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm">
          {t("Não consegui carregar este funil:")} {formatError(error, t)}
        </div>
      ) : isLoading || !data ? (
        <div className="flex flex-1 animate-pulse items-center justify-center text-muted-foreground">
          {t("Carregando…")}
        </div>
      ) : hasActiveFilters && filteredLeads.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-border p-8 text-center">
          <p className="text-sm text-muted-foreground">
            {t("Nenhum lead encontrado com estes filtros.")}
          </p>
          <Button variant="outline" size="sm" onClick={() => setFilters({})}>
            {t("Limpar filtros")}
          </Button>
        </div>
      ) : (
        <KanbanBoard
          pipelineId={pipelineId}
          stages={data.stages}
          leads={filteredLeads}
          pulses={pulses}
          pipeline={data.pipeline}
          selectedIds={selectedIds}
          onSelectionChange={setSelectedIds}
          leadInicial={searchParams.get("lead")}
        />
      )}
      <BulkActionBar
        selectedIds={selectedIds}
        stages={data?.stages ?? []}
        pipelineId={pipelineId}
        vocabulary={data?.pipeline.vocabulary ?? null}
        tagsExistentes={tagsDoQuadro}
        onClear={() => setSelectedIds([])}
      />
    </div>
  );
}
