import { chaveDePlataforma } from "@/lib/ai/runtime/agent";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import type { CredentialRow } from "@/hooks/ai/useCredentials";
import { traduzir } from "@/lib/i18n/dicionario";
import { contarUsoQueBloqueia, type VersaoVinculada } from "@/lib/ai/credenciais/uso";
import { logger } from "@/lib/logger";
import { criarSessaoPkce, gerarNonceSiwc, CLIENTE_DINAMICO_SIWC } from "@/lib/ai/pontos/pkce-da-assinatura";
import { lerLoginCodex } from "@/lib/ai/credenciais/login-codex";
import { lerOuCriarHostIdSiwc } from "@/lib/ai/credenciais/host-siwc";
import { emitirEstado } from "@/lib/agenda/google/estado";
import { env } from "@/lib/env";
import { PROVEDOR_POR_ASSINATURA } from "@/lib/ai/pontos/provedores";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";
import { CredentialsList } from "./_components/CredentialsList";
import { PainelDeLoginCodex } from "./_components/PainelDeLoginCodex";

export const dynamic = "force-dynamic";

const SAFE_COLUMNS =
  "id, organization_id, provider, label, api_key_last4, validated_at, validation_error, models_available, is_active, created_by, created_at, updated_at";

export default async function CredentialsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  const idioma = user.idioma;
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  const supabase = await createClient();
  const { data } = await supabase
    .from("ai_provider_credentials_safe")
    .select(SAFE_COLUMNS)
    .eq("organization_id", activeOrg.orgId)
    .order("created_at", { ascending: false });

  const todas = (data ?? []) as CredentialRow[];

  // O INTERRUPTOR DA INSTALAÇÃO (#1672, itens 6 e 9): desligado, a linha do
  // login por assinatura NÃO aparece aqui — nem no painel, nem na lista de
  // chaves. A leitura do banco continua acontecendo (a linha é da empresa,
  // cifrada e protegida por RLS), mas ninguém a enxerga: o leitor próprio
  // (`lib/ai/credenciais/login-codex.ts`) também recusa quando o módulo está
  // fora.
  const moduloLoginCodex = await moduloLigado(createAdminClient(), "login_codex");

  // A linha do login por assinatura não é uma CHAVE de API: ela guarda o par
  // de tokens da conta da empresa, e vai para o painel próprio. Fora da lista
  // de chaves, ela também não mentiria como "credencial" no agrupamento por
  // provedor (que só conhece quem cadastra chave).
  const linhaDeLogin = moduloLoginCodex
    ? (todas.find((c) => c.provider === PROVEDOR_POR_ASSINATURA) ?? null)
    : null;
  const credentials = todas.filter((c) => c.provider !== PROVEDOR_POR_ASSINATURA);
  const managedAI = ["openai", "anthropic", "openrouter"].some((provider) => !!chaveDePlataforma(provider));
  const canWrite = ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin;
  // O par PKCE DESTA renderização: o link mostrado e o verifier do campo de
  // colagem nascem juntos — e só JUNTOS valem: o `code` que o navegador deixa
  // não troca sem o verifier. Nenhum dos dois circula sozinho (o `code` só
  // existe no navegador de quem conecta, e a troca acontece no servidor), mas
  // isso não faz do verifier um valor público: é segredo de uso ÚNICO, que
  // existe para esta conexão e morre com ela. Não é chave da OpenAI — quem
  // tiver os dois, porém, troca o `code` por tokens.
  //
  // O `state` é ASSINADO com a empresa e a pessoa (o mesmo `emitirEstado` da
  // agenda do Google): a action só troca o código cujo retorno traz este
  // `state`. Sem segredo utilizável o painel não aparece — um login que
  // ninguém consegue conferir não deve ser oferecido.
  let sessaoPkce: ReturnType<typeof criarSessaoPkce> | null = null;
  let siwcAutorizado = false;
  if (moduloLoginCodex && canWrite) {
    try {
      const admin = createAdminClient();
      const [hostId, tokens] = await Promise.all([
        lerOuCriarHostIdSiwc(admin),
        lerLoginCodex({ admin, orgId: activeOrg.orgId }),
      ]);
      siwcAutorizado = tokens !== null;
      if (!hostId) throw new Error("host_siwc_nao_persistido");
      const clientId = tokens?.client_id;
      const nonce = gerarNonceSiwc();
      sessaoPkce = criarSessaoPkce(
        emitirEstado(
          {
            organizationId: activeOrg.orgId,
            userId: user.id,
            authSessionId: clientId ?? CLIENTE_DINAMICO_SIWC,
          },
          { segredo: env.INTERNAL_SECRET, agora: new Date(), nonce },
        ),
        { nonce, ...(clientId ? { clientId } : {}), extAgentHostId: hostId },
      );
    } catch (err) {
      logger.warn("[ai/credentials] login SIWC indisponível (state/host do servidor)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Mesma regra do DELETE — e a mesma da FK `ON DELETE RESTRICT`: TODA versão
  // que aponta para a credencial trava a exclusão, não só a publicada. O número
  // que a tela mostra é o que explica o bloqueio (ver `lib/ai/credenciais/uso.ts`).
  let usageMap: Record<string, number> = {};
  if (credentials.length > 0) {
    const { data: linked } = await supabase
      .from("ai_agent_versions")
      .select("id, credential_id, version_number, status")
      .eq("organization_id", activeOrg.orgId)
      .in("credential_id", credentials.map((c) => c.id));
    usageMap = contarUsoQueBloqueia((linked ?? []) as unknown as VersaoVinculada[]);
  }

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Chaves de acesso à IA", idioma)}</h1>
        <p className="text-sm text-muted-foreground">
          {traduzir(
            managedAI ? "A IA gerenciada já está disponível. Adicione uma chave própria somente se quiser usar outra conta; agentes existentes mantêm suas configurações." : "A conta de inteligência artificial é sua: você contrata direto na Anthropic, OpenAI ou Google e cola a chave aqui. Ela é guardada criptografada e nunca mais aparece na tela depois de salva — nem para você.",
            idioma,
          )}
        </p>
      </header>
      {moduloLoginCodex && canWrite && sessaoPkce && (
        <PainelDeLoginCodex
          url={sessaoPkce.url}
          codeVerifier={sessaoPkce.codeVerifier}
          conectado={linhaDeLogin !== null}
          validada={linhaDeLogin?.validated_at != null}
          siwcAutorizado={siwcAutorizado}
        />
      )}
      <CredentialsList
        initialData={credentials}
        canWrite={canWrite}
        usageMap={usageMap}
      />
    </div>
  );
}
