import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A RODADA DEPOIS DO `catch`: PARA ONDE VAI O ERRO E O QUE VAI PARA A TRILHA.
 *
 * O vizinho `cron-da-prospeccao-nao-engole-o-erro.test.ts` trava a FORMA do
 * `catch` — que o erro esteja numa variável e chegue ao log. Este arquivo trava
 * o DESTINO da rodada, que é o resto do que a issue #1311 pede:
 *
 * 1. a rodada que lança tem de SAIR do processo. O log mora no arquivo de uma
 *    instalação que pode estar quebrada justamente onde ele foi escrito, e num
 *    cron ninguém lê a resposta 500: sem Sentry, a prospecção de um cliente
 *    pode parar por dias e a descoberta passa a depender de alguém reclamar.
 * 2. a rodada que teve EFEITO entra na auditoria; a que não teve, não entra.
 *    A régua `cron-audita-so-quando-ha-efeito.test.ts` lê a forma no AST e
 *    sozinha deixaria passar um cron que NUNCA audita — é com o duplo, aqui,
 *    que se mede tanto a rodada que auditou quanto a que se calou.
 *
 * Os duplos seguem o desenho da régua: a rota é exercitada de verdade, com as
 * bordas (env, worker, audit, Sentry) trocadas, e o que se afirma é o que saiu
 * dela.
 */

const SEGREDO = "segredo-de-cron-do-teste";

vi.mock("@/lib/env", () => ({
  env: { INTERNAL_CRON_SECRET: SEGREDO, INTERNAL_SECRET: "" },
}));

const erroNoLog = vi.fn();
vi.mock("@/lib/logger", () => ({
  logger: {
    error: (...args: unknown[]) => erroNoLog(...args),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

const aoSentry = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => aoSentry(...args),
}));

const auditou = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (...args: unknown[]) => auditou(...args) }));

const tick = vi.fn();
vi.mock("@/lib/prospecting/worker", () => ({
  tickProspecting: (...args: unknown[]) => tick(...args),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));

import type { GET as RotaGET } from "@/app/api/v1/cron/prospecting/route";

type Requisicao = Parameters<typeof RotaGET>[0];

/** A rota só lê `headers.get("authorization")`; um `NextRequest` traria o runtime do Next. */
function requisicaoAutorizada(): Requisicao {
  return { headers: new Headers({ authorization: `Bearer ${SEGREDO}` }) } as never;
}

async function rodarCron() {
  const { GET } = await import("@/app/api/v1/cron/prospecting/route");
  return GET(requisicaoAutorizada());
}

/** O Sentry é chamado em import dinâmico, depois da resposta: espera o encadeamento. */
async function ateChamar(espiao: ReturnType<typeof vi.fn>, tentativas = 20): Promise<void> {
  for (let i = 0; i < tentativas && espiao.mock.calls.length === 0; i++)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a rodada da prospecção que lança", () => {
  it("responde 500 com o requestId costurado ao log", async () => {
    tick.mockRejectedValueOnce(new Error("banco caiu"));
    const resposta = await rodarCron();

    expect(resposta.status).toBe(500);
    const corpo = await resposta.json();
    expect(corpo.error.code).toBe("internal_error");
    expect(corpo.error.message).toContain("banco caiu");

    expect(erroNoLog).toHaveBeenCalledTimes(1);
    const [mensagem, contexto] = erroNoLog.mock.calls[0] as [string, Record<string, unknown>];
    expect(mensagem).toBe("[prospecting.cron] tickProspecting lançou");
    expect(contexto.error).toBe("banco caiu");
    expect(contexto.requestId).toBe(resposta.headers.get("X-Request-Id"));
  });

  it("leva o erro ao Sentry, com o requestId de quem caiu", async () => {
    const falha = new Error("banco caiu");
    tick.mockRejectedValueOnce(falha);
    const resposta = await rodarCron();
    await ateChamar(aoSentry);

    expect(aoSentry).toHaveBeenCalledTimes(1);
    const [erro, contexto] = aoSentry.mock.calls[0] as [Error, { extra?: Record<string, unknown> }];
    expect(erro).toBe(falha);
    expect(contexto.extra?.requestId).toBe(resposta.headers.get("X-Request-Id"));
  });

  it("não audita a rodada que quebrou antes de ter efeito", async () => {
    tick.mockRejectedValueOnce(new Error("banco caiu"));
    await rodarCron();
    await ateChamar(aoSentry);
    expect(auditou).not.toHaveBeenCalled();
  });
});

describe("a rodada da prospecção que volta", () => {
  it("sem efeito não audita", async () => {
    tick.mockResolvedValueOnce({ processed: 0 });
    const resposta = await rodarCron();

    expect(resposta.status).toBe(200);
    expect(auditou).not.toHaveBeenCalled();
  });

  it("com efeito audita uma linha, com a contagem e o requestId", async () => {
    tick.mockResolvedValueOnce({ processed: 3 });
    const resposta = await rodarCron();

    expect(resposta.status).toBe(200);
    expect(auditou).toHaveBeenCalledTimes(1);
    const [linha] = auditou.mock.calls[0] as [Record<string, unknown>];
    expect(linha).toMatchObject({
      action: "prospecting.rodada_executada",
      metadata: { processed: 3 },
      requestId: resposta.headers.get("X-Request-Id"),
    });
  });
});
