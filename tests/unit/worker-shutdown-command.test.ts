import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const fixture = "scripts/fixtures/worker-shutdown.ts";
const dockerfile = readFileSync(resolve(root, "Dockerfile.worker"), "utf8");

/** Só troca main pela sonda; o executável e as opções vêm do CMD real. */
async function probe(signal: NodeJS.Signals, mode = "normal") {
  const cmd = JSON.parse(dockerfile.match(/^CMD (\[.*\])$/m)![1]!) as string[];
  expect(cmd.at(-1)).toBe("workers/agent-worker/main.ts");
  const child = spawn(cmd[0] === "node" ? process.execPath : cmd[0]!, [...cmd.slice(1, -1), fixture, mode], {
    cwd: root,
    env: { PATH: process.env.PATH, NODE_ENV: "test" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let stdout = "";
  let stderr = "";
  let signaledAt = 0;
  let timedOut = false;
  const killTree = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already exited */ } };
  const deadline = setTimeout(() => { timedOut = true; killTree(); }, 12_000);
  try {
    return await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean; elapsedAfterSignal: number }>((done, reject) => {
      child.on("error", reject);
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        if (!signaledAt && stdout.includes("worker-stop-probe: ready\n")) {
          signaledAt = Date.now();
          child.kill(signal);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("close", (code, exitSignal) => done({ code, signal: exitSignal, stdout, stderr, timedOut, elapsedAfterSignal: Date.now() - signaledAt }));
    });
  } finally {
    clearTimeout(deadline);
    killTree();
  }
}

it("o CMD aguarda trabalho por mais de 5s e sai 0 mesmo com handle residual após o drain", async () => {
  const result = await probe("SIGTERM");
  expect(result, JSON.stringify(result)).toMatchObject({ code: 0, signal: null, timedOut: false });
  expect(result.elapsedAfterSignal).toBeGreaterThanOrEqual(5_500);
  expect(result.stdout.trim().split("\n")).toEqual([
    "worker-stop-probe: ready", "worker-stop-probe: stopping", "worker-stop-probe: drained", "worker-stop-probe: telemetry-close",
  ]);
  expect(result.stderr).toBe("");
});

it("falha do trabalho continua saindo 1 depois de tentar fechar a telemetria", async () => {
  const result = await probe("SIGTERM", "work-failure");
  expect(result).toMatchObject({ code: 1, signal: null, timedOut: false });
  expect(result.stderr).toContain("worker-stop-probe: work-failed");
  expect(result.stdout).toContain("worker-stop-probe: telemetry-close");
  expect(result.stdout).not.toContain("worker-stop-probe: drained");
});

it.each(["telemetry-stall", "telemetry-error", "telemetry-pending"])("%s depois de trabalho concluído não impede saída limpa", async (mode) => {
  const result = await probe("SIGTERM", mode);
  expect(result).toMatchObject({ code: 0, signal: null, timedOut: false });
  expect(result.stdout).toContain("worker-stop-probe: drained");
  expect(result.stderr).toContain("telemetria");
  expect(result.elapsedAfterSignal).toBeLessThan(4_000);
  if (mode === "telemetry-stall") expect(result.elapsedAfterSignal).toBeGreaterThanOrEqual(1_900);
});

it("SIGKILL não produz prova de drain nem saída limpa", async () => {
  const result = await probe("SIGKILL");
  expect(result).toMatchObject({ code: null, signal: "SIGKILL", timedOut: false });
  expect(result.stdout).not.toContain("worker-stop-probe: drained");
});

it("o worker de produção usa a mesma fronteira de saída provada pela sonda", () => {
  const main = readFileSync(resolve(root, "workers/agent-worker/main.ts"), "utf8");
  expect(main).toContain("void runWorkerProcess({");
  expect(main).toContain("run: main,");
  expect(main).toContain("Sentry.close(timeoutMs)");
  expect(main).toContain("Sentry.captureException(err)");
});
