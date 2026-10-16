const TELEMETRY_CLOSE_MS = 2_000;

/** main só resolve depois do drain e pool.end. Handles de bibliotecas não
 * podem manter o processo vivo depois disso nem mudar uma parada limpa em
 * SIGKILL. Falha/timeout do trabalho continua sendo saída 1. */
export async function runWorkerProcess(options: {
  run: () => Promise<void>;
  closeTelemetry: (timeoutMs: number) => Promise<boolean>;
  reportFailure: (error: unknown) => void;
}): Promise<never> {
  let exitCode = 0;
  try {
    await options.run();
  } catch (error) {
    exitCode = 1;
    options.reportFailure(error);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), TELEMETRY_CLOSE_MS);
    });
    const closed = await Promise.race([
      Promise.resolve().then(() => options.closeTelemetry(TELEMETRY_CLOSE_MS)),
      deadline,
    ]);
    if (!closed) process.stderr.write("worker: telemetria pendente ao encerrar\n");
  } catch {
    // Telemetria indisponível não desfaz trabalho já drenado. A falha real de
    // run mantém exitCode=1, inclusive quando o envio do incidente também falha.
    process.stderr.write("worker: telemetria indisponível ao encerrar\n");
  } finally {
    clearTimeout(timer);
  }
  process.exit(exitCode);
}
