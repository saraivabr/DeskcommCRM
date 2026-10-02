import type { SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({ id: "user", idioma: "pt-BR" })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: "org" })),
}));
vi.mock("@/lib/routing/eligibles", () => ({ loadEligibleAttendants: vi.fn(async () => []) }));

import { createClient } from "@/lib/supabase/server";
import { GET } from "@/app/api/v1/conversations/counts/route";
import { listConversationsHandler } from "@/app/api/v1/conversations/_handler";
import { getQueuePosition, getQueuePositions, getQueueStatus } from "@/lib/routing/queue";

type Row = Record<string, unknown>;
const now = new Date("2026-10-01T12:00:00Z");
const row = (id: string, comando: string, automatico: boolean): Row => ({
  id, organization_id: "org", status: "open", assigned_to_user_id: null,
  comando_da_conversa: comando, automatico_da_prospeccao: automatico,
  awaiting_since: "2026-10-01T11:00:00Z",
});
const rows = [row("served-prospect", "automatico", true), row("general", "automatico", false),
  row("human-handoff", "aguardando", true), row("human-owner", "humano", true),
  { ...row("foreign", "automatico", true), organization_id: "other" }];

/** Evaluates the actual OR predicate emitted by production, then paginates. */
function database(conversations = rows) {
  const selects: string[] = [];
  const separate = (source: string) => {
    const parts: string[] = []; let depth = 0, start = 0;
    for (let i = 0; i < source.length; i++) {
      if (source[i] === "(") depth++;
      if (source[i] === ")") depth--;
      if (source[i] === "," && depth === 0) { parts.push(source.slice(start, i)); start = i + 1; }
    }
    parts.push(source.slice(start)); return parts;
  };
  const matches = (r: Row, expression: string): boolean => {
    if (expression.startsWith("and(")) return separate(expression.slice(4, -1)).every((x) => matches(r, x));
    if (expression.startsWith("or(")) return separate(expression.slice(3, -1)).some((x) => matches(r, x));
    const [key, op, raw] = expression.split(".");
    const value = raw === "true" ? true : raw === "false" ? false : raw;
    if (op === "eq") return r[key!] === value;
    if (op === "neq") return r[key!] !== value;
    throw new Error(`unsupported predicate: ${expression}`);
  };
  const from = (table: string) => {
    let selected: Row[] = table === "conversations" ? [...conversations] : [{
      organization_id: "org", config: { managed_by: "prospecting", standard_seller: true },
      paused_at: null, archived_at: null, published_version_id: "version",
    }];
    let head = false;
    let pageLimit: number | undefined;
    const chain = {
      select: (columns: string, options?: { head?: boolean }) => { selects.push(columns); head = options?.head === true; return chain; },
      eq: (key: string, value: unknown) => { selected = selected.filter((r) => r[key] === value); return chain; },
      is: (key: string, value: unknown) => { selected = selected.filter((r) => (r[key] ?? null) === value); return chain; },
      in: (key: string, values: unknown[]) => { selected = selected.filter((r) => values.includes(r[key])); return chain; },
      not: (key: string, op: string, raw: string) => { if (op !== "in") throw new Error(op); selected = selected.filter((r) => !raw.slice(1, -1).split(",").includes(String(r[key]))); return chain; },
      or: (predicate: string) => { selected = selected.filter((r) => separate(predicate).some((x) => matches(r, x))); return chain; },
      order: () => chain,
      limit: (limit: number) => { pageLimit = limit; return chain; },
      lte: () => chain,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: head ? null : selected.slice(0, pageLimit), count: selected.length, error: null }).then(resolve),
    };
    return chain;
  };
  const db = { from, auth: { getUser: async () => ({ data: { user: { id: "user" } }, error: null }) } } as unknown as SupabaseClient;
  return { db, selects };
}
const context = { organization_id: "org", requestId: "request", actor: { type: "user" as const, id: "user" } };

beforeEach(() => vi.clearAllMocks());

describe("seller-only Inbox distinguishes served prospects, general waiting and human handoff", () => {
  it("queue list and automatic list use exact availability, preserving handoffs", async () => {
    const { db, selects } = database();
    const queue = await listConversationsHandler(db, context, { limit: 50, status: undefined, comando: ["aguardando", "automatico"] });
    const automatic = await listConversationsHandler(db, context, { limit: 50, status: undefined, comando: ["automatico"] });
    expect(queue.conversations.map((c) => c.id)).toEqual(["general", "human-handoff"]);
    expect(automatic.conversations.map((c) => c.id)).toEqual(["served-prospect"]);
    expect(selects.some((select) => select.includes("automatico_da_prospeccao"))).toBe(true);
  });
  it("counts reflect those same lists", async () => {
    const { db } = database();
    vi.mocked(createClient).mockResolvedValue(db as Awaited<ReturnType<typeof createClient>>);
    const response = await GET(new NextRequest("http://local/api/v1/conversations/counts"));
    expect(await response.json()).toMatchObject({ data: { fila: 2, unassigned: 2, automatico: 1, all: 4 } });
  });
  it("served prospects are filtered before pagination", async () => {
    const { db } = database([...Array.from({ length: 30 }, (_, i) => row(`served-${i}`, "automatico", true)), row("general", "automatico", false)]);
    const queue = await listConversationsHandler(db, context, { limit: 1, status: undefined, comando: ["aguardando", "automatico"] });
    expect(queue.conversations.map((c) => c.id)).toEqual(["general"]);
    expect(queue.has_more).toBe(false);
  });
  it("routing size, wait and positions exclude only served automatic prospects", async () => {
    const { db } = database();
    expect(await getQueueStatus(db, "org", now)).toEqual({ queue_size: 2, avg_wait_seconds: 3600, online_eligible_count: 0 });
    expect(await getQueuePositions(db, "org")).toEqual(new Map([["general", 1], ["human-handoff", 2]]));
    expect(await getQueuePosition(db, "org", now.toISOString(), now)).toBe(2);
  });
});
