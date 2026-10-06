/**
 * O app da Meta DESTA INSTALAÇÃO — o App Secret que assina a entrega e o verify
 * token que responde ao handshake do webhook.
 *
 * ─── Por que INSTALAÇÃO, e não organização ──────────────────────────────────
 *
 * Um App da Meta atende N WABAs de N organizações (modelo Tech Provider): o
 * segredo e o verify token são do APP, não do número. É o mesmo objeto de
 * `platform_google_oauth` (migration 0201) e de `platform_branding` (0155), e
 * este arquivo é um clone declarado do molde do primeiro.
 *
 * A organização continua vindo do TOKEN NO PATH, nunca do corpo — quem amarra o
 * payload a um tenant é a sessão do canal, como o cabeçalho da rota do webhook
 * estabelece desde a issue #236.
 *
 * ─── Por que o `.env` continua sendo lido ───────────────────────────────────
 *
 * O `.env` é o PISO DE ROLLBACK: o `agent.sh` do kit, em falha de update,
 * reverte só a IMAGEM — não o schema. Ou seja, o rollback põe código antigo
 * sobre banco novo por construção, e é o caminho inverso que dói aqui: código
 * NOVO sobre banco que ainda não tem a 0257 (clone que não atualizou, `db push`
 * que falhou). Com o `.env` intacto, a entrega continua sendo aceita em vez de
 * parar de existir no pior momento possível.
 *
 * BANCO PRIMEIRO, `.env` COMO FALLBACK — a mesma ordem de
 * `lib/channels/<provider>/credentials.ts`: no contrário, um env esquecido
 * silenciaria a configuração feita pela tela e o operador não entenderia por que
 * nada mudou.
 *
 * ─── As duas fontes NÃO se misturam ─────────────────────────────────────────
 *
 * O par só é servido inteiro, da mesma origem. Segredo do `.env` com verify
 * token do banco é um app que não existe: a Meta aceita o handshake (feito com
 * o token dela) e toda entrega passa a morrer em `401 invalid_signature` —
 * exatamente a falha SILENCIOSA que a issue #850 mediu, agora difícil de ver
 * porque metade da configuração parece certa.
 *
 * ─── Nunca lança ────────────────────────────────────────────────────────────
 *
 * Esta função é chamada a CADA entrega da Meta. Um throw aqui é 500 no webhook,
 * e a Meta reentrega em backoff um evento que nunca vai melhorar. Toda falha de
 * leitura degrada para o ambiente, e o motivo vai ao log.
 */

import { logger } from "@/lib/logger";
import { createHash } from "node:crypto";
import { graphVersion } from "@/lib/graph-version";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

/** O que a instalação tem em vigor. Campo nulo = não configurado nessa fonte. */
export interface AppDaMetaEmVigor {
  readonly appSecret: string | null;
  readonly verifyToken: string | null;
}

/** Os nomes das variáveis, para a tela poder dizer exatamente o que falta. */
export const VARIAVEIS_DO_APP_DA_META = ["META_APP_SECRET", "META_WEBHOOK_VERIFY_TOKEN"] as const;

function texto(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * O que o AMBIENTE traz — puro, síncrono, sem banco.
 *
 * Separado de propósito: ser síncrono e sem banco mantém testável o que é regra
 * pura (precedência, vazio-como-ausente), e é este objeto que o aviso do
 * primeiro acesso consulta através de `fontesDoAppDaMeta()`.
 */
export function appDaMetaDoAmbiente(
  source: Record<string, string | undefined> = process.env,
): AppDaMetaEmVigor {
  // `.trim()` e não `Boolean()`: o contrato do `.env` deste projeto é que vazio é
  // ausente — o template gera `CHAVE=` —, e `Boolean("   ")` é TRUE. Mesma
  // decisão de `metaPodeReceber` (`lib/channels/meta/webhook.ts`).
  const appSecret = texto(source.META_APP_SECRET);
  const verifyToken = texto(source.META_WEBHOOK_VERIFY_TOKEN);
  return { appSecret: appSecret || null, verifyToken: verifyToken || null };
}

/**
 * Memo de processo com TTL, cópia declarada de `lib/agenda/google/config.ts`.
 *
 * Mora no `globalThis` e não num `let` deste módulo — a diferença não é estilo:
 * o Turbopack instancia o mesmo módulo DUAS vezes no mesmo processo (entrada de
 * rota e entrada de página carregam runtimes diferentes), e um `let` daria dois
 * memos que não se invalidam. Já medido neste repo.
 *
 * O que se memoriza é o PAR JÁ RESOLVIDO, e não a linha do banco: assim uma
 * rajada de entregas da Meta não paga uma ida ao banco por evento. 30s é abaixo
 * do que uma pessoa espera antes de concluir "não salvou", e acima do intervalo
 * entre dois eventos de um mesmo lote.
 */
const TTL_MS = 30_000;

declare global {
  // eslint-disable-next-line no-var
  var __memoDoAppDaMeta:
    { readonly valor: AppDaMetaEmVigor; readonly expiraEm: number } | null | undefined;
}

/** Chamada por quem ESCREVE a credencial — a server action do /admin. */
export function invalidarAppDaMeta(): void {
  globalThis.__memoDoAppDaMeta = null;
  globalThis.__memoDoAppDaMetaNativo = null;
}

interface LinhaDoApp {
  app_secret_encrypted: string | null;
  verify_token_encrypted: string | null;
}

/** Nunca lança: devolve `null` quando não há linha utilizável. */
async function linhaDoBanco(): Promise<LinhaDoApp | null> {
  try {
    const { data, error } = await createAdminClient()
      .from("platform_meta_app")
      .select("app_secret_encrypted, verify_token_encrypted")
      .eq("id", 1)
      .maybeSingle();
    // Clone que ainda não aplicou a 0257 devolve 42P01 aqui. Isso NÃO é erro
    // desta instalação — é o piso de rollback funcionando, e o `.env` assume.
    if (error) {
      logger.info("[meta.app] sem credencial no banco; vale o .env", { codigo: error.code });
      return null;
    }
    return (data as LinhaDoApp | null) ?? null;
  } catch (err) {
    logger.warn("[meta.app] leitura do banco falhou; vale o .env", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * O par do banco, ou `null` — e `null` também quando só METADE dele serve.
 *
 * Meia credencial é indistinguível de nenhuma para quem entrega: com o verify
 * token e sem o segredo o handshake passa e TODA mensagem morre em 401; com o
 * segredo e sem o token o webhook nunca é aceito. Nos dois casos o desfecho
 * certo é o piso (o `.env` inteiro), não um par remendado.
 */
async function parDoBanco(linha: LinhaDoApp | null): Promise<AppDaMetaEmVigor | null> {
  const segredoCifrado = texto(linha?.app_secret_encrypted);
  const tokenCifrado = texto(linha?.verify_token_encrypted);
  if (!segredoCifrado || !tokenCifrado) return null;

  const admin = createAdminClient();
  const appSecret = texto(await decryptWebhookSecret(admin, segredoCifrado));
  const verifyToken = texto(await decryptWebhookSecret(admin, tokenCifrado));
  if (!appSecret || !verifyToken) {
    // Chave mestra trocada, linha corrompida, cifra indisponível. NÃO mistura
    // com o `.env`: cai inteiro para ele.
    logger.warn("[meta.app] credencial do banco não decifrou; vale o .env inteiro");
    return null;
  }
  return { appSecret, verifyToken };
}

/**
 * A configuração em vigor — banco primeiro, `.env` como piso. Nunca lança.
 *
 * Devolve os dois campos possivelmente nulos (instalação sem app configurado):
 * é o estado real de um deploy novo, e quem chama decide — a rota responde 403
 * no handshake e 401 na entrega, que é o desfecho de hoje.
 */
export async function appDaMeta(): Promise<AppDaMetaEmVigor> {
  const memo = globalThis.__memoDoAppDaMeta;
  if (memo && memo.expiraEm > Date.now()) return memo.valor;

  const valor = (await parDoBanco(await linhaDoBanco())) ?? appDaMetaDoAmbiente();
  globalThis.__memoDoAppDaMeta = { valor, expiraEm: Date.now() + TTL_MS };
  return valor;
}

/**
 * As mesmas chaves do `.env`, com os VALORES em vigor — para quem lê por nome de
 * variável, como `metaPodeReceber`.
 *
 * ⚠️ Existe para o aviso do primeiro acesso parar de mentir: ele perguntava só
 * ao ambiente, e depois da 0257 isso diria "não dá para receber pelo canal
 * oficial" a quem acabou de configurar pela tela — mandando o dono editar um
 * arquivo que ele não precisa abrir.
 *
 * `undefined` para o que falta, e não string vazia: é o contrato de
 * `Record<string, string | undefined>` que o leitor espera.
 */
export async function fontesDoAppDaMeta(): Promise<Record<string, string | undefined>> {
  const { appSecret, verifyToken } = await appDaMeta();
  return {
    META_APP_SECRET: appSecret ?? undefined,
    META_WEBHOOK_VERIFY_TOKEN: verifyToken ?? undefined,
  };
}

/** Configuração empresarial server-side; nunca serializar este objeto para o cliente. */
export interface PlatformMetaAppNative {
  readonly appId: string | null;
  readonly configId: string | null;
  readonly revision: number;
  readonly appSecret: string | null;
  readonly apiVersion: string;
  readonly nativeEnabled: boolean;
  readonly instagramEnabled: boolean;
  readonly adsEnabled: boolean;
}

declare global {
  // eslint-disable-next-line no-var
  var __memoDoAppDaMetaNativo:
    { readonly valor: PlatformMetaAppNative; readonly expiraEm: number } | null | undefined;
}

const SEM_LOGIN_NATIVO: Omit<PlatformMetaAppNative, "apiVersion"> = {
  appId: null,
  configId: null,
  revision: 0,
  appSecret: null,
  nativeEnabled: false,
  instagramEnabled: false,
  adsEnabled: false,
};

function identificadorMeta(v: unknown): string | null {
  const valor = texto(v);
  return /^\d{5,30}$/.test(valor) ? valor : null;
}

/** Fonte inteira do ambiente: App ID, configuração e segredo nunca vêm de origens distintas. */
export function platformMetaAppNativeDoAmbiente(
  source: Record<string, string | undefined> = process.env,
): PlatformMetaAppNative {
  const appId = identificadorMeta(source.META_APP_ID);
  const configId = identificadorMeta(source.META_BUSINESS_LOGIN_CONFIG_ID);
  const appSecret = texto(source.META_APP_SECRET) || null;
  const apiVersion = graphVersion();
  if (!appId || !configId || !appSecret) return { ...SEM_LOGIN_NATIVO, apiVersion };

  const nativeEnabled = source.META_NATIVE_ENABLED?.trim() === "true";
  const instagramEnabled = source.META_INSTAGRAM_ENABLED?.trim() === "true";
  const adsEnabled = source.META_ADS_ENABLED?.trim() === "true";
  // Inteiro seguro, estável por configuração, inclusive rotação de segredo. O hash não sai ao cliente.
  const revision = Number.parseInt(
    createHash("sha256")
      .update(
        JSON.stringify([appId, configId, appSecret, nativeEnabled, instagramEnabled, adsEnabled]),
      )
      .digest("hex")
      .slice(0, 12),
    16,
  );
  return {
    appId,
    configId,
    revision,
    appSecret,
    apiVersion,
    nativeEnabled,
    instagramEnabled,
    adsEnabled,
  };
}

/**
 * Banco vence quando contém identidade nativa, mesmo com capacidade desligada.
 * Falha de cifra/leitura ou ausência do snapshot persistido fecha o login.
 * O callback valida a mesma revisão no banco; ambiente deve ser configurado
 * explicitamente no singleton antes de autorizar clientes.
 */
export async function getPlatformMetaAppNative(): Promise<PlatformMetaAppNative> {
  const memo = globalThis.__memoDoAppDaMetaNativo;
  if (memo && memo.expiraEm > Date.now()) return memo.valor;
  const apiVersion = graphVersion();
  let valor: PlatformMetaAppNative = { ...SEM_LOGIN_NATIVO, apiVersion };
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("platform_meta_app")
      .select(
        "app_id, config_id, config_revision, app_secret_encrypted, native_enabled, instagram_enabled, ads_enabled",
      )
      .eq("id", 1)
      .maybeSingle();
    if (error) {
      logger.warn("[meta.app] login nativo indisponível: leitura falhou", { codigo: error.code });
    } else if (data) {
      const appId = identificadorMeta(data.app_id);
      const configId = identificadorMeta(data.config_id);
      const revision = Number(data.config_revision);
      const encrypted = texto(data.app_secret_encrypted);
      const appSecret = encrypted
        ? texto(await decryptWebhookSecret(admin, encrypted)) || null
        : null;
      if (appId && configId && appSecret && Number.isSafeInteger(revision) && revision > 0) {
        valor = {
          appId,
          configId,
          revision,
          appSecret,
          apiVersion,
          nativeEnabled: data.native_enabled === true,
          instagramEnabled: data.instagram_enabled === true,
          adsEnabled: data.ads_enabled === true,
        };
      }
    }
  } catch {
    logger.warn("[meta.app] login nativo indisponível: configuração não pôde ser validada");
  }
  globalThis.__memoDoAppDaMetaNativo = { valor, expiraEm: Date.now() + TTL_MS };
  return valor;
}

/** Callback identity remains available when login capabilities are disabled. */
export async function getPlatformMetaAppPrivacy(): Promise<{
  appId: string;
  appSecret: string;
} | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("platform_meta_app")
    .select("app_id,app_secret_encrypted")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw new Error("Meta app privacy configuration unavailable");
  const appId = identificadorMeta(data?.app_id);
  const encrypted = texto(data?.app_secret_encrypted);
  if (!appId || !encrypted) return null;
  const appSecret = texto(await decryptWebhookSecret(admin, encrypted));
  return appSecret ? { appId, appSecret } : null;
}
