import { streamText, type generateText, type ToolSet } from "ai";

type Opcoes = Parameters<typeof streamText>[0];
type Resultado = Pick<
  Awaited<ReturnType<typeof generateText>>,
  "text" | "usage" | "response" | "responseMessages" | "steps" | "toolCalls"
> & { finishReason: "stop" | "tool-calls" };

// Preserve a identidade/status do erro do provedor. O chamador usa o marcador
// para não recomeçar o prompt na reserva depois de uma ferramenta já iniciada.
const falhasAposFerramenta = new WeakSet<object>();

export function podeRepetirFalhaDaAssinatura(erro: unknown): boolean {
  return !(typeof erro === "object" && erro !== null && falhasAposFerramenta.has(erro));
}

/**
 * SIWC exige stream completo. As promessas do SDK podem RESOLVER mesmo após
 * `onError` ou término incompleto: texto parcial nunca prova sucesso.
 * Uma ferramenta pode executar antes desse erro. Marcar o início (não apenas
 * o sucesso) impede repetir também um efeito cujo resultado ficou incerto.
 */
export async function executarStreamDaAssinatura(opcoes: Opcoes): Promise<Resultado> {
  let ferramentaIniciada = false;
  let erroOriginal: unknown = null;
  const tools: ToolSet | undefined = opcoes.tools && Object.fromEntries(
    Object.entries(opcoes.tools).map(([nome, definicao]) => {
      const execute = definicao.execute;
      return [nome, !execute ? definicao : {
        ...definicao,
        execute: (...args: Parameters<typeof execute>) => {
          ferramentaIniciada = true;
          return execute(...args);
        },
      }];
    }),
  );

  try {
    const stream = streamText({
      ...opcoes,
      tools,
      maxRetries: 0,
      streamRetries: 0,
      providerOptions: {
        ...opcoes.providerOptions,
        openai: { ...opcoes.providerOptions?.openai, store: false },
      },
      onError: async (evento) => {
        erroOriginal ??= evento.error;
        await opcoes.onError?.(evento);
      },
    });
    const [text, usage, response, responseMessages, steps, toolCalls, finishReason] = await Promise.all([
      stream.text, stream.usage, stream.response, stream.responseMessages,
      stream.steps, stream.toolCalls, stream.finishReason,
    ]);
    if (erroOriginal !== null) throw erroOriginal;
    if (finishReason !== "stop" && finishReason !== "tool-calls") {
      throw new Error(`siwc_stream_incomplete:${finishReason}`);
    }
    return { text, usage, response, responseMessages, steps, toolCalls, finishReason };
  } catch (falha) {
    const original = erroOriginal ?? falha;
    const erro = typeof original === "object" && original !== null
      ? original : new Error("siwc_stream_failed", { cause: original });
    if (ferramentaIniciada) falhasAposFerramenta.add(erro);
    throw erro;
  }
}
