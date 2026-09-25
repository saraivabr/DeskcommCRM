"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";
import { useOrganizationTransition } from "./OrganizationTransitionProvider";
import { CaretDown, Storefront } from "@/lib/ui/icons";
import { useAuth } from "@/hooks/auth/AuthProvider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { setActiveOrg } from "@/app/actions/shell/setActiveOrg";

export function TenantSwitcher({
  sidebar = false,
  collapsed = false,
}: {
  sidebar?: boolean;
  collapsed?: boolean;
}) {
  const t = useT();
  const { user, activeOrg: active } = useAuth();
  const canSwitch = (user.organizations?.length ?? 0) > 1 || user.is_platform_admin;
  const workspace = (
    <>
      {active?.marca?.logoUrl ? (
        <div className="rounded-md dark:bg-white dark:p-1 dark:shadow-sm">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            data-brand-layer="organization"
            src={active.marca.logoUrl}
            alt={active.marca.nome ?? active.name}
            className="h-7 w-7 rounded-md object-contain"
          />
        </div>
      ) : (
        <span
          aria-hidden
          className="flex h-[29px] w-[29px] shrink-0 items-center justify-center rounded-lg border border-border bg-primary/5 text-xs font-bold"
        >
          {[...(active?.marca?.nome ?? active?.name ?? "")][0]}
        </span>
      )}
      {!collapsed && (
        <span className="min-w-0 flex-1 text-left">
          <span className="block truncate text-xs font-bold">
            {active?.marca?.nome ?? active?.name}
          </span>
          <span className="mt-1 block max-w-[100px] text-[10px] leading-[14px] font-normal text-muted-foreground">
            {t("Espaço de trabalho")}
          </span>
        </span>
      )}
      {canSwitch && !collapsed && (
        <CaretDown size={12} aria-hidden className="shrink-0 text-muted-foreground" />
      )}
    </>
  );
  if (!canSwitch)
    return sidebar ? (
      <div
        className="mx-3 flex h-[76px] shrink-0 items-center gap-2.5 border-b border-border px-2.5"
        title={active?.name}
      >
        {workspace}
      </div>
    ) : null;

  return <InteractiveTenantSwitcher sidebar={sidebar} workspace={workspace} />;
}

function InteractiveTenantSwitcher({
  sidebar,
  workspace,
}: {
  sidebar: boolean;
  workspace: ReactNode;
}) {
  const t = useT();
  const { user, activeOrg: active } = useAuth();
  const transition = useOrganizationTransition();
  const [isPending, setPending] = useState(false);
  const switchTo = async (orgId: string) => {
    if (orgId === active?.orgId) return;
    flushSync(() => {
      setPending(true);
      transition.begin(t("Carregando organização…"));
    });
    try {
      const result = await setActiveOrg(orgId);
      if (!result.ok) throw new Error(result.error);
      // Novo documento elimina QueryClient, subscriptions e respostas em voo.
      window.location.assign("/app/inbox");
    } catch {
      transition.cancel();
      setPending(false);
      toast.error(
        t("Não foi possível trocar de organização. Seu acesso pode ter mudado. Tente novamente."),
      );
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/*
          ⚠️ NO CELULAR ESTE BOTÃO É SÓ O ÍCONE, e isso não é economia de estilo:
          é o que faz o cabeçalho caber.

          Medido na tela, numa instalação real em 360px: com o nome escrito, o
          botão ocupava 153px e o cabeçalho tinha 14 sobreposições, a pior de
          96px — o nome da organização por baixo do campo de busca, e a busca por
          cima do sino. Hambúrguer + nome + busca + sino + avatar não cabem em
          360px, e o bloco do meio é `flex-1 justify-center` entre dois
          `shrink-0`: quando falta espaço ele transborda por cima dos vizinhos em
          vez de encolher.

          Só o ícone: 40px, e as sobreposições vão a zero. O nome completo
          continua a UM TOQUE, dentro do menu que este botão já abre — e
          continua no `aria-label`, para quem usa leitor de tela.

          `min-w-0` sozinho NÃO resolve (medido): ele deixa o flex comprimir o
          texto, mas a 18px visíveis o nome vira "M…", e as colisões de 13px com
          a busca continuam. O espaço é que não existe.
        */}
        <Button
          variant="ghost"
          size="sm"
          disabled={isPending || !!user.support}
          className={
            sidebar
              ? "mx-3 flex h-[76px] shrink-0 gap-2.5 rounded-none border-b border-border px-2.5 hover:bg-primary/5"
              : "gap-2"
          }
          aria-label={`${t("Organização")}: ${active?.name ?? t("Selecionar org")}`}
          title={user.support ? "Saia do acompanhamento para trocar de organização" : undefined}
          data-testid="tenant-switcher"
        >
          {sidebar ? (
            workspace
          ) : (
            <>
              <Storefront size={16} weight="duotone" aria-hidden />
              <span className="hidden max-w-[160px] truncate md:inline">
                {active?.name ?? "Selecionar org"}
              </span>
              <CaretDown size={12} aria-hidden className="hidden md:inline" />
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[220px]">
        {user.organizations.map((org) => (
          <DropdownMenuItem
            key={org.organization_id}
            data-testid={`tenant-switcher-item-${org.organization_id}`}
            onClick={() => {
              void switchTo(org.organization_id);
            }}
            className="flex items-center justify-between"
          >
            <span className="truncate">{org.organization_name}</span>
            {active?.orgId === org.organization_id && (
              <span className="text-xs text-muted-foreground">✓</span>
            )}
          </DropdownMenuItem>
        ))}
        {user.is_platform_admin && (
          <DropdownMenuItem asChild>
            <Link href="/admin/tenants">{t("Gerenciar organizações")}</Link>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
