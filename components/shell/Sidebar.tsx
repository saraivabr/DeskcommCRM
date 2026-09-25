"use client";

import Link from "next/link";
import { LogotipoDoProduto, SimboloDoProduto } from "@/components/branding/MarcaDoProduto";
import { gsap } from "gsap";
import { usePathname } from "next/navigation";
import { useTransition, useEffect, useRef } from "react";
import { PanelLeftClose, PanelLeftOpen, House } from "lucide-react";
import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";
import { toggleSidebar } from "@/app/actions/shell/toggleSidebar";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { TenantSwitcher } from "./TenantSwitcher";
import { VersionFooter } from "./VersionFooter";
import { useMarcaDaInstalacao } from "@/lib/branding/contexto";
import { searchable, workspaceGroups } from "@/lib/navigation/registry";
import { DEFAULT_APP_NAME } from "@/lib/branding";

import { ArtisanIcon } from "@/components/brand/ArtisanIcon";

export function SidebarContent({
  collapsed,
  showCollapseControl = true,
  onNavigate,
}: {
  collapsed: boolean;
  showCollapseControl?: boolean;
  onNavigate?: () => void;
}) {
  const t = useT();
  const pathname = usePathname();
  const { user, activeOrg } = useAuth();
  const brand = useMarcaDaInstalacao();
  const [pending, startTransition] = useTransition();
  const destinations = searchable(
    user.is_platform_admin && !user.support,
    activeOrg?.role ?? null,
    activeOrg?.interface_settings,
    activeOrg?.modulos_ligados ?? [],
  );
  const name = brand.name;
  const logo = brand.logoUrl;
  const productBrand = !logo && name === DEFAULT_APP_NAME;
  const linkClass = (active: boolean) =>
    cn(
      "workspace-nav-item min-h-[42px]! rounded-[9px]! px-[15px]! py-[10px]! text-[13px]!",
      active && "is-active bg-primary/10! font-semibold! text-foreground! shadow-none!",
      collapsed && "justify-center px-0!",
    );
  return (
    <>
      <Link
        href="/app"
        onClick={onNavigate}
        aria-label={`${name} — início`}
        className={cn(
          "mx-3 flex h-[92px] shrink-0 items-center gap-2 border-b border-border px-4",
          collapsed && "justify-center px-2",
        )}
      >
        {productBrand ? (
          collapsed ? (
            <SimboloDoProduto nome={name} className="h-9 w-9" />
          ) : (
            <LogotipoDoProduto nome={name} className="h-10 w-full" />
          )
        ) : logo && !collapsed ? (
          <div className="rounded-lg dark:bg-white dark:p-1 dark:shadow-sm">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={logo} alt={name} className="h-7 max-w-40 object-contain" />
          </div>
        ) : (
          <span className="text-[22px] font-semibold tracking-[-0.06em]">
            {collapsed ? [...name][0] : name}
          </span>
        )}
      </Link>
      {activeOrg && <TenantSwitcher sidebar collapsed={collapsed} />}
      <nav
        aria-label={t("Navegação principal")}
        className="min-h-0 flex-1 overflow-y-auto px-3 pt-7 pb-3"
      >
        <Link
          href="/app"
          onClick={onNavigate}
          title={collapsed ? t("Início") : undefined}
          aria-label={collapsed ? t("Início") : undefined}
          aria-current={pathname === "/app" ? "page" : undefined}
          className={linkClass(pathname === "/app")}
        >
          <House strokeWidth={1.5} className="h-[18px] w-[18px] shrink-0" aria-hidden />
          {!collapsed && <span>{t("Início")}</span>}
        </Link>
        {workspaceGroups(destinations).map((group) => (
          <div key={group.id} className="pt-[22px]!">
            {!collapsed && (
              <p className="px-[15px] pb-[8px] text-[9px] font-bold tracking-[0.18em] text-muted-foreground uppercase">
                {t(group.label)}
              </p>
            )}
            {group.items.map((item) => {
              const active = pathname === item.href || pathname.startsWith(item.href + "/");
              const label = item.workspace?.sidebarLabel ?? item.workspace?.label ?? item.label;
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onNavigate}
                  title={collapsed ? t(label) : undefined}
                  aria-label={collapsed ? t(label) : undefined}
                  aria-current={active ? "page" : undefined}
                  className={linkClass(active)}
                >
                  <Icon size={19} weight="light" aria-hidden className="shrink-0" />
                  {!collapsed && <span>{t(label)}</span>}
                </Link>
              );
            })}
          </div>
        ))}
        <div className="pt-7!">
          <Link
            href="/app/ferramentas"
            onClick={onNavigate}
            title={collapsed ? t("Todas as ferramentas") : undefined}
            aria-label={collapsed ? t("Todas as ferramentas") : undefined}
            aria-current={pathname === "/app/ferramentas" ? "page" : undefined}
            className={linkClass(pathname === "/app/ferramentas")}
          >
            <ArtisanIcon symbol="tools" className="h-5 w-5 shrink-0" />
            {!collapsed && <span>{t("Todas as ferramentas")}</span>}
          </Link>
        </div>
      </nav>
      <div className="shrink-0 px-3 pb-3 md:pb-[59px]">
        {destinations.some((d) => d.group === "organizacao") && (
          <Link
            href="/app/settings"
            onClick={onNavigate}
            title={collapsed ? t("Configurações") : undefined}
            aria-label={collapsed ? t("Configurações") : undefined}
            className={linkClass(pathname.startsWith("/app/settings"))}
          >
            <ArtisanIcon symbol="settings" className="h-5 w-5 shrink-0" />
            {!collapsed && <span>{t("Configurações")}</span>}
          </Link>
        )}
        <div className={cn("mt-4 flex items-center justify-between gap-1 border-t border-border pt-3", collapsed && "flex-col")}>
          <VersionFooter collapsed={collapsed} onNavigate={onNavigate} />
          {showCollapseControl && (
            <button
              type="button"
              disabled={pending}
              onClick={() => startTransition(() => toggleSidebar(collapsed))}
              aria-label={t(collapsed ? "Expandir sidebar" : "Recolher sidebar")}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
            >
              {collapsed ? (
                <PanelLeftOpen size={18} aria-hidden />
              ) : (
                <>
                  <PanelLeftClose size={18} aria-hidden />
                  <span className="sr-only">{t("Recolher")}</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

export function Sidebar({ collapsed }: { collapsed: boolean }) {
  const element = useRef<HTMLElement>(null);
  const previous = useRef(collapsed);
  useEffect(() => {
    if (previous.current === collapsed) return;
    previous.current = collapsed;
    const media = gsap.matchMedia();
    media.add("(prefers-reduced-motion: no-preference)", () => {
      gsap.fromTo(
        element.current,
        { width: collapsed ? 208 : 76 },
        { width: collapsed ? 76 : 208, duration: 0.22, ease: "power2.out", clearProps: "width" },
      );
    });
    return () => media.revert();
  }, [collapsed]);
  return (
    <aside
      ref={element}
      data-workspace-sidebar
      className={cn(
        "workspace-sidebar sticky top-0 z-30 flex h-dvh shrink-0 flex-col",
        collapsed ? "w-[76px]" : "w-[208px]",
      )}
    >
      <SidebarContent collapsed={collapsed} />
    </aside>
  );
}
