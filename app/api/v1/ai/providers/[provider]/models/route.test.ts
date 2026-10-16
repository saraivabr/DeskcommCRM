import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth/require-role";
import { listarModelosDaAssinatura, FalhaAoListarModelosDaAssinatura } from "@/lib/ai/catalogo/modelos-da-assinatura";
import { GET } from "./route";
import { fail } from "@/lib/api/wrappers";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/ai/catalogo/modelos-da-assinatura", async (original) => ({
  ...await original<object>(), listarModelosDaAssinatura: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
const orgId = "33333333-3333-4333-8333-333333333333";
const listar = (provider = "openai-assinatura") => GET(new NextRequest("http://localhost/api/v1/ai/providers/openai-assinatura/models"), { params: Promise.resolve({ provider }) });
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: "u" }, org: { orgId, role: "admin" } } as never);
});
describe("catálogo da assinatura por empresa", () => {
  it("consulta somente a empresa autorizada e mantém a ordem do provedor", async () => {
    vi.mocked(listarModelosDaAssinatura).mockResolvedValue([{ model_id: "conta-b" }, { model_id: "conta-a" }] as never);
    const response = await listar();
    expect(response.status).toBe(200);
    expect(listarModelosDaAssinatura).toHaveBeenCalledWith(orgId);
    expect((await response.json()).data.models.map((m: { model_id: string }) => m.model_id)).toEqual(["conta-b", "conta-a"]);
  });
  it("sem papel de gestor não consulta nem confirma provedor conhecido", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: fail("forbidden", "Papel insuficiente.", 403) });
    expect((await listar()).status).toBe(403);
    expect((await listar("desconhecido")).status).toBe(403);
    expect(listarModelosDaAssinatura).not.toHaveBeenCalled();
    expect(requireRole).toHaveBeenCalledWith("manager", expect.objectContaining({ resource: "ai_providers" }));
  });
  it("ausência de credencial é diferente de falha da API", async () => {
    vi.mocked(listarModelosDaAssinatura).mockResolvedValue(null);
    expect((await listar()).status).toBe(409);
    vi.mocked(listarModelosDaAssinatura).mockRejectedValue(new FalhaAoListarModelosDaAssinatura("http_403", { status: 403, cause: new Error("SEGREDO_NAO_PUBLICAR") }));
    const response = await listar();
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).toContain("http_403");
    expect(body).not.toContain("SEGREDO_NAO_PUBLICAR");
  });
  it("falhas inesperadas não expõem detalhes internos", async () => {
    vi.mocked(listarModelosDaAssinatura).mockRejectedValue(new Error("SEGREDO_NAO_PUBLICAR"));
    const response = await listar();
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("SEGREDO_NAO_PUBLICAR");
  });
});
