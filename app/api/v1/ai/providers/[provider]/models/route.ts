/**
 * GET /api/v1/ai/providers/:provider/models
 *
 * Lê do catálogo curado `ai_models` (tabela GLOBAL, RLS read-all).
 * Retorna modelos não-deprecated ordenados por default-first depois preço.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { ehProvedorSuportado, PROVEDOR_POR_ASSINATURA } from "@/lib/ai/pontos/provedores";
import { listarModelosDaAssinatura, FalhaAoListarModelosDaAssinatura } from "@/lib/ai/catalogo/modelos-da-assinatura";

export const dynamic = "force-dynamic";

// A lista única (`lib/ai/pontos/provedores.ts`) — não uma quarta cópia. Esta
// rota alimenta o seletor de modelos; com a lista velha, pedir os modelos da
// OpenRouter devolvia "provedor desconhecido" para um provedor que a tela ao
// lado oferecia.

const MODEL_COLUMNS =
  "id, provider, model_id, display_name, description, context_window, input_price_per_million_cents, output_price_per_million_cents, supports_tools, is_default_for_provider, deprecated_at, released_at";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { provider } = await ctx.params;

  // Gestor para cima, como a irmã `GET /api/v1/ai/providers` e a tela que usa
  // esta rota (o editor do agente). Pela assinatura, listar é chamar a OpenAI
  // com o token da empresa e regravar `models_available` — não é leitura de
  // catálogo. A autorização vem ANTES da validação do provedor: quem não pode
  // listar recebe 403 para qualquer provedor, e não aprende pelo 404 quais
  // a instalação conhece.
  const authz = await requireRole("manager", { requestId, resource: "ai_providers" });
  if (!authz.ok) return authz.response;
  const activeOrg = authz.org;

  if (!ehProvedorSuportado(provider)) {
    return fail("not_found", "Provider desconhecido.", 404, { requestId });
  }

  // O catálogo da assinatura é por CONTA, não global como `ai_models`.
  // Consultá-lo sob o token da organização evita gravar nomes/modelos de uma
  // conta em uma tabela compartilhada entre tenants.
  if (provider === PROVEDOR_POR_ASSINATURA) {
    let models;
    try {
      models = await listarModelosDaAssinatura(activeOrg.orgId);
    } catch (erro) {
      return fail("provider_unavailable", "Não foi possível consultar os modelos da conta ChatGPT. Tente novamente.", 502, {
        requestId,
        details: { motivo: erro instanceof FalhaAoListarModelosDaAssinatura ? erro.motivo : "falha_interna" },
      });
    }
    if (!models) {
      return fail("credential_invalid", "Conecte a assinatura do ChatGPT para listar os modelos.", 409, { requestId });
    }
    return ok({ models }, { requestId });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("ai_models")
    .select(MODEL_COLUMNS)
    .eq("provider", provider)
    .is("deprecated_at", null)
    .order("is_default_for_provider", { ascending: false })
    .order("input_price_per_million_cents", { ascending: true });

  if (error) {
    return fail("internal_error", "Erro ao listar modelos.", 500, { requestId });
  }

  return ok({ models: data ?? [] }, { requestId });
}
