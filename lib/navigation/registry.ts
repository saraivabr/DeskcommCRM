import type { Icon as PhosphorIcon } from "@phosphor-icons/react";

import { type Role } from "@/lib/auth/types";
import {
  Sparkle,
  InstagramLogo,
  Bell,
  BookOpen,
  Brain,
  Buildings,
  CalendarBlank,
  ChartBar,
  ChartLineUp,
  ClipboardText,
  ClockCountdown,
  ClockCounterClockwise,
  FileText,
  Flag,
  FlowArrow,
  Funnel,
  Gauge,
  Inbox,
  Kanban,
  Key,
  Lightbulb,
  ListChecks,
  Lock,
  Megaphone,
  Palette,
  PaperPlaneTilt,
  Phone,
  Plugs,
  PlugsConnected,
  PuzzlePiece,
  Receipt,
  Robot,
  ScalesSimple,
  ShieldCheck,
  Signpost,
  Storefront,
  Tag,
  UserCircle,
  Users,
  UsersThree,
  WebhooksLogo,
} from "@/lib/ui/icons";

import {
  NAV_CATALOG,
  NAV_GROUPS,
  type NavMetadata,
  type NavGroup,
  type NavGroupId,
} from "./catalogo";
import type { ModuloOpcional } from "@/lib/instalacao/modulos";

import { destinosDaInterface, type InterfaceSettings } from "./interface";
export { NAV_GROUPS, GRUPO_NO_RODAPE } from "./catalogo";
export type { NavGroup, NavGroupId } from "./catalogo";
const ICONS = {
  Sparkle,
  InstagramLogo,
  Bell,
  BookOpen,
  Brain,
  Buildings,
  CalendarBlank,
  ChartBar,
  ChartLineUp,
  ClipboardText,
  ClockCountdown,
  ClockCounterClockwise,
  FileText,
  Flag,
  FlowArrow,
  Funnel,
  Gauge,
  Inbox,
  Kanban,
  Key,
  Lightbulb,
  ListChecks,
  Lock,
  Megaphone,
  Palette,
  PaperPlaneTilt,
  Phone,
  Plugs,
  PlugsConnected,
  PuzzlePiece,
  Receipt,
  Robot,
  ScalesSimple,
  ShieldCheck,
  Signpost,
  Storefront,
  Tag,
  UserCircle,
  Users,
  UsersThree,
  WebhooksLogo,
};
export interface NavDestination extends Omit<NavMetadata, "icon"> {
  icon: PhosphorIcon;
}
export const NAV_DESTINATIONS: NavDestination[] = NAV_CATALOG.map((d) => ({
  ...d,
  icon: ICONS[d.icon],
}));
/**
 * Único ponto de decisão de permissão da navegação.
 *
 * É o que dispensa os sete `usePermission()` que o Sidebar chamava em sequência
 * — hooks não rodam em laço condicional, então cada permissão exigia sua linha.
 * Como função pura, um `.filter()` resolve todas.
 */
export { canSee } from "./interface";

/** Projeção do sidebar: só o uso diário, agrupado, sem grupo vazio. */
export function sidebarGroups(
  isPlatformAdmin: boolean,
  role: Role | null,
  settings?: InterfaceSettings,
  modulos?: readonly ModuloOpcional[],
): Array<{ group: NavGroup; items: NavDestination[] }> {
  const visible = new Set<string>(
    destinosDaInterface(settings, isPlatformAdmin, role, modulos).map((d) => d.href),
  );
  return NAV_GROUPS.map((group) => ({
    group,
    items: NAV_DESTINATIONS.filter(
      (d) =>
        d.group === group.id &&
        (d.sidebar || (!group.hub && !!settings?.destinos)) &&
        visible.has(d.href),
    ),
  })).filter(
    (g) =>
      g.items.length > 0 ||
      (g.group.hub && NAV_DESTINATIONS.some((d) => d.group === g.group.id && visible.has(d.href))),
  );
}

/**
 * Projeção do hub: TODAS as telas do grupo — inclusive as que já estão no
 * sidebar. O hub é inventário, não sobra; é onde se descobre o que existe.
 *
 * A ordem das seções é a de primeira aparição no registro, então reordenar a
 * jornada é reordenar o array — não há uma segunda lista para manter em sincronia.
 */
export function hubSections(
  group: NavGroupId,
  isPlatformAdmin: boolean,
  role: Role | null,
  settings?: InterfaceSettings,
  modulos?: readonly ModuloOpcional[],
): Array<{ section: string; items: NavDestination[] }> {
  const porSecao = new Map<string, NavDestination[]>();
  const visible = new Set<string>(
    destinosDaInterface(settings, isPlatformAdmin, role, modulos).map((d) => d.href),
  );
  for (const d of NAV_DESTINATIONS) {
    if (d.group !== group || !visible.has(d.href)) continue;
    const secao = d.section ?? "";
    const atual = porSecao.get(secao);
    if (atual) atual.push(d);
    else porSecao.set(secao, [d]);
  }
  return [...porSecao.entries()].map(([section, items]) => ({ section, items }));
}

/** Projeção do ⌘K: todo destino visível, do sidebar ou não. */
export function searchable(
  isPlatformAdmin: boolean,
  role: Role | null,
  settings?: InterfaceSettings,
  modulos?: readonly ModuloOpcional[],
): NavDestination[] {
  const visible = new Set<string>(
    destinosDaInterface(settings, isPlatformAdmin, role, modulos).map((d) => d.href),
  );
  return NAV_DESTINATIONS.filter((d) => visible.has(d.href));
}

/** Menu diário extraído do mesmo catálogo que alimenta busca e configurações. */
export function workspaceGroups(destinations: readonly NavDestination[]) {
  return (
    [
      { id: "trabalhar", label: "Trabalhar" },
      { id: "criar", label: "Criar" },
      { id: "organizar", label: "Organizar" },
    ] as const
  )
    .map((group) => ({
      ...group,
      items: destinations
        .filter((d) => d.workspace?.section === group.id)
        .sort((a, b) => (a.workspace?.order ?? 0) - (b.workspace?.order ?? 0)),
    }))
    .filter((group) => group.items.length > 0);
}

export const TOOL_GROUPS = [
  { id: "atendimento", label: "Atendimento" },
  { id: "vendas", label: "Vendas" },
  { id: "marketing", label: "Marketing" },
  { id: "ia", label: "Inteligência artificial" },
  { id: "operacao", label: "Operação" },
  { id: "plataforma", label: "Plataforma" },
] as const;
export type ToolGroupId = (typeof TOOL_GROUPS)[number]["id"];

/** Agrupamento de descoberta; não altera os grupos dos hubs existentes. */
export function toolGroup(destination: NavDestination): ToolGroupId {
  const { href, group } = destination;
  if (
    href.startsWith("/app/instagram") ||
    href.startsWith("/app/ads/") ||
    href === "/app/campaigns"
  )
    return "marketing";
  if (
    ["/app/tasks", "/app/activities", "/app/metrics", "/app/faturamento", "/app/comandas"].includes(
      href,
    )
  )
    return "operacao";
  if (group === "ia" || href === "/app/ai/evolution") return "ia";
  if (group === "crm") return "vendas";
  if (group === "atendimento") return "atendimento";
  if (group === "analise") return "operacao";
  return "plataforma";
}

/** Recebe somente a projeção já autorizada. Nenhum catálogo paralelo de URLs. */
export function toolSections(
  destinations: readonly NavDestination[],
  query = "",
  category?: ToolGroupId,
) {
  const normalize = (text: string) =>
    text
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase();
  const term = normalize(query.trim());
  return TOOL_GROUPS.filter((group) => !category || group.id === category)
    .map((group) => ({
      ...group,
      items: destinations.filter(
        (destination) =>
          destination.href !== "/app" &&
          destination.href !== "/app/ferramentas" &&
          toolGroup(destination) === group.id &&
          normalize(
            `${destination.workspace?.label ?? ""} ${destination.label} ${destination.description} ${group.label}`,
          ).includes(term),
      ),
    }))
    .filter((group) => group.items.length > 0);
}
