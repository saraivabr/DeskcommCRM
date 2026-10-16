// @vitest-environment node
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const directories: string[] = [];
function checkout() {
  const directory = mkdtempSync(join(tmpdir(), "ci-smoke-guard-"));
  directories.push(directory);
  mkdirSync(join(directory, "scripts"));
  copyFileSync("scripts/ci-smoke.sh", join(directory, "scripts/ci-smoke.sh"));
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
it("recusa execução fora do CI antes de criar arquivos ou iniciar dependências", () => {
  const directory = checkout();
  expect(() =>
    execFileSync("bash", ["scripts/ci-smoke.sh"], {
      cwd: directory,
      env: { ...process.env, CI: "false" },
      stdio: "pipe",
    }),
  ).toThrow(/somente CI=true/);
  expect(existsSync(join(directory, ".env.e2e"))).toBe(false);
});
it.each([".env", ".env.local", ".env.production", ".env.production.local", ".env.e2e"])(
  "preserva e recusa %s preexistente",
  (file) => {
    const directory = checkout();
    writeFileSync(join(directory, file), "NAO_ALTERAR=fixture\n");
    expect(() =>
      execFileSync("bash", ["scripts/ci-smoke.sh"], {
        cwd: directory,
        env: { ...process.env, CI: "true" },
        stdio: "pipe",
      }),
    ).toThrow(/ambiente limpo/);
    expect(readFileSync(join(directory, file), "utf8")).toBe("NAO_ALTERAR=fixture\n");
  },
);

function readinessSource() {
  const script = readFileSync("scripts/ci-smoke.sh", "utf8");
  const start = script.indexOf("async function probe(");
  const end = script.indexOf("\nJS", start);
  if (start < 0 || end < 0) throw new Error("Sonda de prontidão ausente");
  return script.slice(start, end);
}
it("prontidão Redis usa POST JSON PING na raiz e exige PONG", () => {
  const setup = `
    process.env.NEXT_PUBLIC_SUPABASE_URL='http://localhost:54321';
    process.env.UPSTASH_REDIS_REST_URL='http://localhost:3998';
    global.fetch=async (url, init)=> {
      if (url.includes('/rest/v1/')) return { ok:true, status:200, json:async()=>[] };
      const correct=url==='http://localhost:3998' && init.method==='POST' && init.body==='["PING"]' && init.headers['Content-Type']==='application/json';
      return { ok:correct, status:correct?200:404, json:async()=>correct?{result:'PONG'}:{} };
    };
    global.setTimeout=(resolve)=>{resolve();return 0;};
  `;
  expect(() =>
    execFileSync(process.execPath, ["-e", setup + readinessSource()], { stdio: "pipe" }),
  ).not.toThrow();
});
it("HTTP 200 sem PONG reprova com diagnóstico por serviço sem revelar corpo ou token", () => {
  const setup = `
    process.env.NEXT_PUBLIC_SUPABASE_URL='http://localhost:54321';
    process.env.UPSTASH_REDIS_REST_URL='http://localhost:3998';
    process.env.UPSTASH_REDIS_REST_TOKEN='SEGREDO_SENTINELA';
    global.fetch=async (url)=>({ok:true,status:200,json:async()=>url.includes('/rest/v1/')?[]:{error:'SEGREDO_SENTINELA'}});
    global.setTimeout=(resolve)=>{resolve();return 0;};
  `;
  let output = "";
  try {
    execFileSync(process.execPath, ["-e", setup + readinessSource()], { stdio: "pipe" });
    throw new Error("Prontidão aceitou Redis sem PONG");
  } catch (error) {
    // A saída do processo, não a mensagem execFile que também carrega o comando.
    output = String((error as { stderr?: Buffer }).stderr ?? "");
  }
  expect(output).toContain('"redis":{"ready":false,"status":200');
  expect(output).toContain('"postgrest":{"ready":true');
  expect(output).not.toContain("SEGREDO_SENTINELA");
});

function runIntegrationFixture(omitSeed = false) {
  const directory = checkout();
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const pnpm = join(bin, "pnpm");
  writeFileSync(
    pnpm,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == 'exec tsx scripts/seed-e2e-credentials.ts' ]]; then
  printf '%s\n' 'local fixture' > .e2e-creds.json
  printf '%s\n' seeded >> order
elif [[ "$1 $2 $3" == 'exec playwright test' ]]; then
  [[ -s .e2e-creds.json ]] || { echo 'Missing credentials before collection' >&2; exit 23; }
  printf '%s\n' collected >> order
  printf '%s\n' "$@" > specs
else
  exit 24
fi
`,
  );
  chmodSync(pnpm, 0o755);
  const script = readFileSync("scripts/ci-smoke.sh", "utf8");
  const start = script.lastIndexOf('if [[ "$integration" = true ]]; then');
  if (start < 0) throw new Error("Bloco da integração ausente");
  let block = script.slice(start);
  if (omitSeed) block = block.replace("  pnpm exec tsx scripts/seed-e2e-credentials.ts\n", "");
  execFileSync("bash", ["-c", `set -euo pipefail\nintegration=true\n${block}`], {
    cwd: directory,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    stdio: "pipe",
  });
  return directory;
}
it("seeds local credentials and TOTP before collecting integrated browser specs", () => {
  const directory = runIntegrationFixture();
  expect(readFileSync(join(directory, "order"), "utf8")).toBe("seeded\ncollected\n");
  const specs = readFileSync(join(directory, "specs"), "utf8");
  expect(specs).toContain("tests/e2e/reset-password-mfa.spec.ts");
  expect(specs).toContain("tests/e2e/instagram-social.spec.ts");
});
it("negative control: integrated collection refuses a missing credential fixture", () => {
  expect(() => runIntegrationFixture(true)).toThrow(/Missing credentials before collection/);
});
