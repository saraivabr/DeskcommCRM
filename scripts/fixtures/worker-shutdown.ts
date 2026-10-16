/** Sonda sem rede: usa o laço e a saída reais, com trabalho e handle residuais. */
import { setTimeout as sleep } from "node:timers/promises";
import { rodarLoopDaFila } from "@/lib/agent-engine/queue/loop";
import { runWorkerProcess } from "@/workers/agent-worker/process-lifecycle";

const mode = process.argv[2] ?? "normal";
// O caso normal tem de ultrapassar os 5s de encerramento do wrapper antigo.
const workMs = mode === "normal" ? 6_000 : 20;
const residualHandle = setInterval(() => undefined, 60_000);

void runWorkerProcess({
  run: () => new Promise<void>((resolve, reject) => {
    const abort = new AbortController();
    let stopping = false;
    let ready = false;
    let claimed = false;
    let finishWork!: () => void;
    const acceptedWork = new Promise<void>((done) => { finishWork = done; });
    const loop = rodarLoopDaFila({
      relogio: async () => null,
      claimar: async () => {
        if (claimed) return [];
        claimed = true;
        return ["accepted-work"];
      },
      aoClaimar: () => undefined,
      dormir: async (ms) => {
        if (!ready) {
          ready = true;
          process.stdout.write("worker-stop-probe: ready\n");
        }
        await sleep(ms, undefined, { signal: abort.signal });
      },
      deveParar: () => stopping,
      intervalos: { ociosoMs: 60_000, retryMs: 60_000 },
      log: { info: () => {}, warn: () => {}, error: () => { process.exitCode = 1; } },
    });
    process.once("SIGTERM", () => {
      stopping = true;
      process.stdout.write("worker-stop-probe: stopping\n");
      abort.abort();
      // Conclusão assíncrona de trabalho aceito antes do sinal, sem novo claim.
      setTimeout(finishWork, workMs);
      void Promise.all([loop, acceptedWork]).then(() => {
        if (mode === "work-failure") throw new Error("probe_work_failed");
        process.stdout.write("worker-stop-probe: drained\n");
        // O handle segue ativo quando run resolve: regressão medida em produção.
        if (!residualHandle.hasRef()) throw new Error("probe_without_residual_handle");
        resolve();
      }).catch(reject);
    });
  }),
  closeTelemetry: async () => {
    process.stdout.write("worker-stop-probe: telemetry-close\n");
    if (mode === "telemetry-stall") return new Promise<boolean>(() => undefined);
    if (mode === "telemetry-error") throw new Error("probe_telemetry_failed");
    if (mode === "telemetry-pending") return false;
    return true;
  },
  reportFailure: () => { process.stderr.write("worker-stop-probe: work-failed\n"); },
});
