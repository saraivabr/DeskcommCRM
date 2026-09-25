"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowUpRight, Search } from "lucide-react";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { searchable, TOOL_GROUPS, toolSections, type ToolGroupId } from "@/lib/navigation/registry";
import { cn } from "@/lib/utils";

export function ToolsCatalog() {
  const t = useT();
  const { user, activeOrg } = useAuth();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<ToolGroupId>();
  const destinations = searchable(
    user.is_platform_admin && !user.support,
    activeOrg?.role ?? null,
    activeOrg?.interface_settings,
    activeOrg?.modulos_ligados ?? [],
  );
  const available = toolSections(destinations);
  const sections = toolSections(destinations, query, category);
  const count = sections.reduce((sum, section) => sum + section.items.length, 0);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 md:px-8 md:py-10">
      <p className="text-xs font-medium tracking-wide text-muted-foreground">
        {t("SEU ESPAÇO DE TRABALHO")}
      </p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">{t("Todas as ferramentas")}</h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
        {t("Encontre o que precisa para atender, vender, criar e organizar sua operação.")}
      </p>
      <div className="relative mt-7 max-w-xl">
        <Search
          aria-hidden
          size={18}
          className="pointer-events-none absolute top-3.5 left-4 text-muted-foreground"
        />
        <input
          type="search"
          aria-label={t("Buscar ferramentas")}
          placeholder={t("O que você precisa fazer?")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-11 w-full rounded-xl border bg-background pr-4 pl-11 text-sm outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <div aria-label={t("Categorias de ferramentas")} className="mt-5 flex flex-wrap gap-2">
        {[
          { id: undefined, label: t("Todas") },
          ...TOOL_GROUPS.filter((group) => available.some((section) => section.id === group.id)),
        ].map((group) => (
          <button
            key={group.id ?? "todas"}
            type="button"
            aria-pressed={category === group.id}
            onClick={() => setCategory(group.id)}
            className={cn(
              "min-h-11 rounded-full border px-4 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden",
              category === group.id
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {t(group.label)}
          </button>
        ))}
      </div>
      <p role="status" className="mt-6 text-xs text-muted-foreground">
        {count} {t(count === 1 ? "ferramenta disponível" : "ferramentas disponíveis")}
      </p>
      {sections.length === 0 ? (
        <div className="mt-6 rounded-2xl border border-dashed p-8 text-center">
          <h2 className="font-medium">{t("Nenhuma ferramenta encontrada")}</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("Tente outra palavra ou veja todas as categorias.")}
          </p>
          <button
            type="button"
            className="mt-4 min-h-11 rounded-lg border px-4 text-sm focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              setQuery("");
              setCategory(undefined);
            }}
          >
            {t("Limpar filtros")}
          </button>
        </div>
      ) : (
        <div className="mt-5 space-y-9">
          {sections.map((section) => (
            <section key={section.id} aria-labelledby={`tools-${section.id}`}>
              <h2 id={`tools-${section.id}`} className="mb-3 text-base font-semibold">
                {t(section.label)}
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {section.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className="group flex gap-3 rounded-xl border border-border/80 bg-card p-4 transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
                    >
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
                        <Icon size={21} aria-hidden />
                      </span>
                      <div className="min-w-0 flex-1">
                        <h3 className="flex items-center justify-between gap-2 text-sm font-semibold">
                          {t(item.workspace?.label ?? item.label)}
                          <ArrowUpRight
                            aria-hidden
                            size={14}
                            className="shrink-0 text-muted-foreground"
                          />
                        </h3>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                          {t(item.description)}
                        </p>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
