import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { roleAtLeast, type Role } from "@/lib/auth/types";
import { CONVERSATION_TERMINAL_STATUSES } from "@/lib/schemas/messaging";

export const homeInputSchema = z
  .object({
    scope: z.enum(["mine", "team"]).default("mine"),
    days: z.union([z.literal(7), z.literal(30)]).default(7),
  })
  .strict();
export type HomeInput = z.infer<typeof homeInputSchema>;
export type HomeMeasure = {
  id: string;
  label: string;
  description: string;
  href: string;
  count: number | null;
};
export type HomeOverview = {
  scope: HomeInput["scope"];
  canSeeTeam: boolean;
  updatedAt: string;
  attention: HomeMeasure[];
  movement: HomeMeasure[];
  activities: { id: string; title: string; at: string; href: string }[] | null;
};

/** Only use a cookie/session client. RLS remains the authority for row visibility. */
export async function loadHomeOverview(
  db: SupabaseClient,
  orgId: string,
  userId: string,
  role: Role,
  input: HomeInput,
  now = new Date(),
): Promise<HomeOverview> {
  const canSeeTeam = roleAtLeast(role, "manager");
  const canSeeCases = roleAtLeast(role, "agent");
  if (input.scope === "team" && !canSeeTeam)
    throw new Error("Sua permissão não permite consultar a equipe.");
  const since = new Date(now.getTime() - input.days * 86400000).toISOString();
  const until = now.toISOString();
  const base = (table: string, owner: string) => {
    let query = db
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId);
    if (input.scope === "mine") query = query.eq(owner, userId);
    return query;
  };
  const definitions = [
    {
      id: "conversations",
      label: "Conversas abertas",
      description: "Conversas atribuídas, ainda não fechadas nem arquivadas.",
      href: input.scope === "mine" ? "/app/inbox?filter=mine" : "/app/inbox?filter=all",
    },
    {
      id: "leads",
      label: "Fechamentos previstos vencidos",
      description: "Oportunidades abertas com data prevista de fechamento anterior a hoje (UTC).",
      href: "/app/kanban",
    },
    ...(canSeeCases
      ? [{
          id: "agent-cases",
          label: "Casos da IA aguardando resposta",
          description: "Casos abertos pela IA que aguardam uma resposta humana.",
          href: "/app/ai/cases",
        }]
      : []),
    {
      id: "tasks",
      label: "Tarefas atrasadas",
      description: "Tarefas pendentes ou em andamento cujo prazo já passou.",
      href: "/app/tasks",
    },
    {
      id: "new-conversations",
      label: "Conversas iniciadas",
      description: "Criadas no período.",
      href: "/app/inbox",
    },
    {
      id: "new-leads",
      label: "Oportunidades criadas",
      description: "Criadas no período.",
      href: "/app/kanban",
    },
    {
      id: "appointments",
      label: "Compromissos no período",
      description: "Com início no período, exceto cancelados.",
      href: "/app/agenda",
    },
    {
      id: "won",
      label: "Oportunidades ganhas",
      description: "Marcadas como ganhas e fechadas no período.",
      href: "/app/kanban",
    },
  ];
  const results = await Promise.allSettled([
    base("conversations", "assigned_to_user_id")
      .not("assigned_to_user_id", "is", null)
      .not("status", "in", `(${CONVERSATION_TERMINAL_STATUSES.join(",")})`),
    base("crm_leads", "owner_user_id")
      .eq("status", "open")
      .lt("expected_close_date", until.slice(0, 10)),
    ...(canSeeCases
      ? [(() => {
          let query = db
            .from("agent_cases")
            .select("id,conversations!inner(assigned_to_user_id)", { count: "exact", head: true })
            .eq("organization_id", orgId)
            .eq("conversations.organization_id", orgId)
            .eq("status", "awaiting_human");
          if (input.scope === "mine")
            query = query.eq("conversations.assigned_to_user_id", userId);
          return query;
        })()]
      : []),
    base("crm_tasks", "assigned_to").in("status", ["pending", "in_progress"]).lt("due_date", until),
    base("conversations", "assigned_to_user_id").gte("created_at", since).lte("created_at", until),
    base("crm_leads", "owner_user_id").gte("created_at", since).lte("created_at", until),
    base("calendar_appointments", "owner_user_id")
      .neq("status", "cancelled")
      .gte("starts_at", since)
      .lte("starts_at", until),
    base("crm_leads", "owner_user_id")
      .eq("status", "won")
      .gte("closed_at", since)
      .lte("closed_at", until),
  ]);
  const measures = definitions.map((definition, index) => {
    const result = results[index];
    return {
      ...definition,
      count: result?.status === "fulfilled" && !result.value.error ? result.value.count : null,
    };
  });
  let activityQuery = db
    .from("conversations")
    .select("id,last_message_at,contacts:contact_id!inner(display_name,is_anonymized)")
    .eq("organization_id", orgId)
    .eq("contacts.is_anonymized", false)
    .not("last_message_at", "is", null)
    .order("last_message_at", { ascending: false })
    .limit(5);
  if (input.scope === "mine") activityQuery = activityQuery.eq("assigned_to_user_id", userId);
  let activities: HomeOverview["activities"] = null;
  try {
    const result = await activityQuery;
    if (!result.error)
      activities = (result.data ?? []).map((item) => ({
        id: String(item.id),
        title: rotuloDoContato(Array.isArray(item.contacts) ? item.contacts[0] : item.contacts),
        at: String(item.last_message_at),
        href: `/app/inbox?id=${item.id}`,
      }));
  } catch {
    /* The client renders this section as unavailable, never empty. */
  }
  return {
    scope: input.scope,
    canSeeTeam,
    updatedAt: until,
    attention: measures.slice(0, canSeeCases ? 4 : 3),
    movement: measures.slice(canSeeCases ? 4 : 3),
    activities,
  };
}
