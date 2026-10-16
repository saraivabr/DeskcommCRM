// @vitest-environment node
import { stepCountIs, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
type LanguageModelV4StreamPart = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>["stream"] extends ReadableStream<infer Part> ? Part : never;
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { executarStreamDaAssinatura, podeRepetirFalhaDaAssinatura } from "./stream-da-assinatura";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const texto: LanguageModelV4StreamPart[] = [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: "Resposta parcial" },
  { type: "text-end", id: "t" },
];
const messages = [{ role: "user" as const, content: "Faça a operação" }];
function leitura(partes: LanguageModelV4StreamPart[]) {
  return { stream: new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      partes.forEach((parte) => controller.enqueue(parte));
      controller.close();
    },
  }) };
}
function modelo(partes: LanguageModelV4StreamPart[]) {
  return new MockLanguageModelV4({ doStream: async () => leitura(partes) });
}

describe("stream SIWC com o SDK real, sem rede", () => {
  it("aceita término confirmado e mantém a fita de mensagens do SDK", async () => {
    const r = await executarStreamDaAssinatura({ model: modelo([
      ...texto, { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
    ]), messages });
    expect(r.text).toBe("Resposta parcial");
    expect(r.finishReason).toBe("stop");
    expect(r.responseMessages).toEqual(r.response.messages);
    expect(r.responseMessages[0]?.role).toBe("assistant");
    expect(r.usage.totalTokens).toBe(2);
  });

  it("recusa erro após texto mesmo quando as promessas do SDK resolvem", async () => {
    const erro = Object.assign(new Error("provider_failure"), { statusCode: 503 });
    await expect(executarStreamDaAssinatura({ model: modelo([
      ...texto, { type: "error", error: erro },
      { type: "finish", finishReason: { unified: "error", raw: "error" }, usage },
    ]), messages })).rejects.toBe(erro);
    expect(podeRepetirFalhaDaAssinatura(erro)).toBe(true);
  });

  it.each(["length", "content-filter", "other"] as const)(
    "recusa término %s sem tratar texto parcial como sucesso", async (motivo) => {
      await expect(executarStreamDaAssinatura({ model: modelo([
        ...texto, { type: "finish", finishReason: { unified: motivo, raw: motivo }, usage },
      ]), messages })).rejects.toThrow(`siwc_stream_incomplete:${motivo}`);
    },
  );

  it("recusa stream interrompido sem evento terminal", async () => {
    await expect(executarStreamDaAssinatura({ model: modelo(texto), messages })).rejects.toThrow();
  });

  it("marca erro posterior à execução para impedir fallback que repete a ferramenta", async () => {
    const erro = Object.assign(new Error("provider_failed_after_tool"), { statusCode: 503 });
    const execute = vi.fn(async () => ({ ok: true }));
    const doStream = vi.fn()
      .mockImplementationOnce(async () => leitura([
        { type: "stream-start", warnings: [] },
        { type: "tool-call", toolCallId: "call-1", toolName: "operar", input: "{}" },
        { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
      ]))
      .mockImplementationOnce(async () => leitura([
        ...texto, { type: "error", error: erro },
        { type: "finish", finishReason: { unified: "error", raw: "error" }, usage },
      ]));
    await expect(executarStreamDaAssinatura({
      model: new MockLanguageModelV4({ doStream }), messages,
      stopWhen: stepCountIs(3),
      tools: { operar: tool({ inputSchema: z.object({}), execute }) },
    })).rejects.toBe(erro);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(doStream).toHaveBeenCalledTimes(2);
    expect(podeRepetirFalhaDaAssinatura(erro)).toBe(false);
  });

  it("aceita término confirmado com ferramenta sem inventar nova tentativa", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const r = await executarStreamDaAssinatura({ model: modelo([
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "call-1", toolName: "operar", input: "{}" },
      { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
    ]), messages, tools: { operar: tool({ inputSchema: z.object({}), execute }) } });
    expect(r.finishReason).toBe("tool-calls");
    expect(r.toolCalls).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("não repete pedido automaticamente quando o provedor falha antes do stream", async () => {
    const erro = Object.assign(new Error("provider_not_reached"), { statusCode: 503 });
    const doStream = vi.fn(async () => { throw erro; });
    await expect(executarStreamDaAssinatura({ model: new MockLanguageModelV4({ doStream }), messages }))
      .rejects.toBe(erro);
    expect(doStream).toHaveBeenCalledTimes(1);
  });
});
