import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({ ok: true, org: { orgId: "org" } })),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import {
  ehVendedorPadraoDaProspeccao,
  resolverAgenteDaConversa,
} from "@/lib/ai/agents/agente-da-conversa";
import { orgTemAutomatico } from "@/lib/ai/agents/org-tem-automatico";
import { GET } from "@/app/api/v1/ai/automatico-ativo/route";
import { createClient } from "@/lib/supabase/server";

const marker = { managed_by: "prospecting", standard_seller: true };
const seller = { id: "seller", config: marker, paused_at: null, published_version_id: "seller-v" };
const regular = { id: "regular", config: {}, paused_at: null, published_version_id: "regular-v" };

function database(rows: unknown[], error: unknown = null): SupabaseClient {
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    is: vi.fn(async () => ({ data: rows, error })),
  };
  return { from: vi.fn(() => chain) } as unknown as SupabaseClient;
}

beforeEach(() => vi.clearAllMocks());

describe("vendedora padrão tem escopo de prospecção", () => {
  it.each([null, undefined, [], "prospecting", { managed_by: "prospecting" }, { standard_seller: true }, { managed_by: "prospecting", standard_seller: "true" }])(
    "não confunde config parcial ou inválida com marker: %j", (config) => {
      expect(ehVendedorPadraoDaProspeccao(config)).toBe(false);
    },
  );

  it("preserva stickiness explícita da conversa", () => {
    expect(resolverAgenteDaConversa([seller], { active_ai_agent_id: "seller" })).toEqual({
      agente: seller, motivo: "stickiness_da_conversa",
    });
  });

  it("não seleciona a vendedora pelo canal nem por ser única na organização", () => {
    expect(resolverAgenteDaConversa([seller], { versoesPublicadasNaSessao: ["seller-v"] })).toEqual({
      agente: null, motivo: "indefinido",
    });
    expect(resolverAgenteDaConversa([seller], null).agente).toBeNull();
  });

  it("o fallback mantém o atendente comum ao lado da vendedora", () => {
    expect(resolverAgenteDaConversa([seller, regular], { versoesPublicadasNaSessao: ["seller-v", "regular-v"] }).agente).toBe(regular);
    expect(resolverAgenteDaConversa([seller, regular], null)).toEqual({
      agente: regular, motivo: "unico_da_organizacao",
    });
  });

  it.each([
    { rows: [seller], expected: false },
    { rows: [seller, regular], expected: true },
    { rows: [{ ...regular, config: { managed_by: "prospecting" } }], expected: true },
    { rows: [{ ...regular, paused_at: "2026-10-01T00:00:00Z" }, seller], expected: false },
  ])("contadores de automático geral concordam: $expected", async ({ rows, expected }) => {
    const db = database(rows);
    vi.mocked(createClient).mockResolvedValue(db as Awaited<ReturnType<typeof createClient>>);
    expect(await orgTemAutomatico(db, "org")).toBe(expected);
    const response = await GET({} as Parameters<typeof GET>[0]);
    expect(await response.json()).toMatchObject({ data: { ativo: expected } });
    const query = vi.mocked(db.from).mock.results[0]?.value as unknown as { select: ReturnType<typeof vi.fn>; eq: ReturnType<typeof vi.fn> };
    expect(query.select).toHaveBeenCalledWith(expect.stringContaining("config"));
    expect(query.eq).toHaveBeenCalledWith("organization_id", "org");
  });

  it("erro de leitura conserva desconhecido no contador e erro na rota", async () => {
    const db = database([], { message: "unavailable" });
    vi.mocked(createClient).mockResolvedValue(db as Awaited<ReturnType<typeof createClient>>);
    expect(await orgTemAutomatico(db, "org")).toBeUndefined();
    expect((await GET({} as Parameters<typeof GET>[0])).status).toBe(500);
  });
});
