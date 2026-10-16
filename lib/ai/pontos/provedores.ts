/**
 * OS PROVEDORES QUE O SISTEMA SABE USAR — a lista que substituiu o CHECK.
 *
 * A migration 0127 removeu os três CHECKs que prendiam `provider` em
 * `anthropic|openai|google` no banco, porque eles tornavam impossível cadastrar
 * OpenRouter (ou qualquer provedor novo, ou um modelo local) e porque cada
 * provedor novo viraria uma migration. Com a coluna aberta, a garantia de que a
 * tela não oferece opção inválida passa a morar aqui.
 *
 * A defesa em profundidade continua sendo dupla, e é importante entender de
 * onde vem cada metade:
 *
 *  - **Esta lista** é o que a tela OFERECE. Ela existe para o operador não
 *    escolher algo que o sistema não sabe executar.
 *  - **O registry** (`createDefaultRegistry`) é o que EXECUTA. Um provider que
 *    chegue até ele sem entrada correspondente falha com
 *    `LlmProviderUnknownError` — erro tipado que diz o que fazer, e não uma
 *    violação de constraint que o operador leria como bug do produto.
 *
 * As duas metades precisam concordar, e é justamente esse tipo de par que este
 * repo já viu divergir em silêncio (catálogo × preço). Por isso
 * `tests/unit/provedores-x-registry.test.ts` casa uma com a outra.
 */

/** Como a chave daquele provedor é validada e o que a tela precisa pedir. */
export interface ProvedorSuportado {
  id: string;
  /** Nome como o operador conhece. */
  rotulo: string;
  /** Uma frase sobre quando escolher este, para quem não acompanha o mercado. */
  quandoUsar: string;
  /**
   * O provedor aceita apontar para outro endpoint (é OpenAI-compatível)? É o
   * que habilita gateway próprio e, no roteiro, modelo local.
   */
  aceitaEndpointProprio: boolean;
  /** O catálogo de modelos vem de uma API pública que dá para sincronizar? */
  catalogoSincronizavel: boolean;
  /** Onde o operador pega a chave — a tela mostra o link. */
  ondePegarAChave: string;
  /** Como a chave começa — vira placeholder do campo, para a pessoa reconhecer que copiou a coisa certa. */
  prefixoDaChave: string;
}

/**
 * O LOGIN POR ASSINATURA (#1639) — vocabulário da credencial E da conversa.
 *
 * A linha em `ai_provider_credentials` deste provedor guarda um PAR DE TOKENOS
 * (access + refresh), não uma chave de API: quem a lê é o painel de conexão da
 * empresa, a renovação e o resolvedor da assinatura — nunca um leitor genérico
 * (`lib/ai/credentials.ts` recusa este provider de propósito: mandaria o JSON
 * dos tokens como se fosse chave).
 *
 * A constante mora aqui (e não em `./reserva-da-assinatura`) porque é
 * vocabulário: quem escreve e quem lê importam do mesmo lugar, sem ciclo. Ela
 * vem ANTES de `PROVEDORES` porque é dentro da lista, na entrada do provedor,
 * que este id é usado — um `const` declarado depois da lista estouraria em TDZ
 * na hora de avaliar o próprio array.
 */
export const PROVEDOR_POR_ASSINATURA = "openai-assinatura";

export const PROVEDORES = [
  {
    id: "anthropic",
    rotulo: "Anthropic (Claude)",
    quandoUsar:
      "O padrão recomendado para conversar com o cliente: é o que melhor segue instruções longas e usa as ferramentas do CRM.",
    aceitaEndpointProprio: false,
    catalogoSincronizavel: false,
    ondePegarAChave: "https://console.anthropic.com/settings/keys",
    prefixoDaChave: "sk-ant-…",
  },
  {
    id: "openai",
    rotulo: "OpenAI (GPT)",
    quandoUsar:
      "Necessário para transcrever áudio e para indexar o seu material — esses dois pontos usam tecnologia da OpenAI mesmo quando o resto está em outro provedor.",
    aceitaEndpointProprio: true,
    catalogoSincronizavel: false,
    ondePegarAChave: "https://platform.openai.com/api-keys",
    prefixoDaChave: "sk-…",
  },
  {
    id: PROVEDOR_POR_ASSINATURA,
    rotulo: "OpenAI pela assinatura (ChatGPT)",
    quandoUsar:
      "Conecte sua conta pessoal do ChatGPT dentro dos limites da assinatura; para operação em volume, prefira uma chave de API da organização. Uma chave da própria organização pode servir de reserva.",
    // A assinatura não se aponta para outro endereço nem sincroniza catálogo:
    // o endpoint é o da própria OpenAI e o modelo vem do que a conta tem.
    aceitaEndpointProprio: false,
    catalogoSincronizavel: false,
    // Não existe chave a copiar aqui: quem conecta é o painel de Credenciais
    // desta instalação (Sign in with ChatGPT por PKCE). O link aponta para o
    // serviço cuja ASSINATURA este provedor usa; catálogo e inferência SIWC
    // usam a API pública oficial em `api.openai.com`.
    ondePegarAChave: "https://chatgpt.com/",
    // Placeholder do campo de chave, que para este provedor não tem o que
    // colar: o texto já diz a recusa antes de a pessoa tentar.
    prefixoDaChave: "conectado pelo login — não se cola chave",
  },
  {
    id: "google",
    rotulo: "Google (Gemini)",
    quandoUsar:
      "Alternativa com contexto muito longo e custo baixo para tarefas de classificação.",
    aceitaEndpointProprio: false,
    catalogoSincronizavel: false,
    ondePegarAChave: "https://aistudio.google.com/apikey",
    prefixoDaChave: "AIza…",
  },
  {
    id: "openrouter",
    rotulo: "OpenRouter",
    quandoUsar:
      "Uma chave só dá acesso a centenas de modelos de dezenas de fabricantes, inclusive os gratuitos. É o caminho mais simples para experimentar sem abrir conta em cada provedor.",
    aceitaEndpointProprio: true,
    catalogoSincronizavel: true,
    ondePegarAChave: "https://openrouter.ai/keys",
    prefixoDaChave: "sk-or-…",
  },
  {
    id: "deepseek",
    rotulo: "DeepSeek",
    quandoUsar:
      "Muito barata e desconta sozinha o trecho repetido da conversa, sem você configurar nada — o custo cai para quem atende com um roteiro que não muda.",
    aceitaEndpointProprio: true,
    catalogoSincronizavel: true,
    ondePegarAChave: "https://platform.deepseek.com/api_keys",
    prefixoDaChave: "sk-…",
  },
] as const satisfies readonly ProvedorSuportado[];
// `as const satisfies` e não anotação de tipo: a anotação apagaria os literais
// e `Provider` viraria `string`, deixando o compilador aceitar qualquer texto
// como provedor — que é exatamente a garantia que esta lista existe para dar.

/**
 * Só os ids, na forma que o `z.enum` exige (tupla não-vazia de literais).
 *
 * Existe para os pontos de ESCRITA derivarem daqui em vez de repetir a lista:
 * a rota de credenciais, o schema de versão do agente e o diálogo da tela
 * tinham cada um a sua cópia, e quando a 0127 abriu o banco para a OpenRouter
 * as três continuaram recusando — o produto oferecia um provedor que não tinha
 * como ser cadastrado.
 */
export const IDS_DE_PROVEDOR = PROVEDORES.map((p) => p.id) as unknown as readonly [
  (typeof PROVEDORES)[number]["id"],
  ...(typeof PROVEDORES)[number]["id"][],
];

export const PROVEDOR_POR_ID: ReadonlyMap<string, ProvedorSuportado> = new Map(
  PROVEDORES.map((p) => [p.id, p]),
);

export function ehProvedorSuportado(id: string): boolean {
  return PROVEDOR_POR_ID.has(id);
}

export type ProvedorComChave = (typeof PROVEDORES)[number]["id"];
