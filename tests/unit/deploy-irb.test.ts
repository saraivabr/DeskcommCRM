import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SHA = "a".repeat(40);
const APP_DIGEST = `sha256:${"b".repeat(64)}`;
const WORKER_DIGEST = `sha256:${"c".repeat(64)}`;
const APP = `ghcr.io/saraivabr/deskcomm-app@${APP_DIGEST}`;
const WORKER = `ghcr.io/saraivabr/deskcomm-worker@${WORKER_DIGEST}`;
const previous = {
  services: {
    app: { image: "app:previous", environment: { APP_VERSION: "old", KEEP: "literal $value" }, command: ["node", "server.js"] },
    worker: { image: "worker:previous", environment: { APP_VERSION: "old", KEEP: "worker" }, command: ["pnpm", "exec", "tsx", "workers/agent-worker/main.ts"] },
    "voice-worker": { image: "voice:previous", environment: { KEEP: "voice" } },
    scheduler: { image: "scheduler:previous", command: ["original", "cron"] },
  },
};
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function deployment(failure = "", active = true, args = [SHA, APP_DIGEST, WORKER_DIGEST]) {
  const dir = mkdtempSync(join(tmpdir(), "irb-deploy-"));
  dirs.push(dir);
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "root"));
  writeFileSync(join(dir, "root", "compose.json"), JSON.stringify(previous));
  if (failure === "config") mkdirSync(join(dir, "root", "compose.json.tmp"));
  writeFileSync(join(dir, "state.json"), JSON.stringify({ worker: active, app: true, changed: false }));
  writeFileSync(join(dir, "bin", "docker"), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.IRB_FIXTURE;
const failure = process.env.IRB_FAILURE;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(args) + '\\n');
const statePath = path.join(dir, 'state.json');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const fail = (name) => { if (failure === name && !state.failed) { state.failed = true; save(); process.exit(1); } };
if (args[0] === 'pull') { fail('pull'); process.exit(0); }
if (args[0] === 'image' && args[1] === 'inspect') {
  const ref = args[2];
  const worker = ref.includes('deskcomm-worker');
  const revision = failure === 'revision' ? 'wrong' : '${SHA}';
  process.stdout.write(JSON.stringify([{ Id: worker ? 'worker-new-id' : 'app-new-id', RepoDigests: failure === 'digest' ? [] : [ref], Config: { Labels: { 'org.opencontainers.image.revision': revision }, Env: ['APP_VERSION=' + (failure === 'image-version' ? 'wrong' : '${SHA}')] } }]));
  process.exit(0);
}
if (args[0] === 'inspect') {
  const id = args.find((arg) => arg === 'app-container' || arg === 'worker-container');
  if (!id) process.exit(1);
  const worker = id === 'worker-container';
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'root', 'compose.json'), 'utf8')).services[worker ? 'worker' : 'app'];
  const isNew = config.image.includes('@sha256:');
  const env = { ...config.environment };
  if (worker && isNew && failure === 'worker-version') env.APP_VERSION = 'wrong';
  const exitCode = !state.worker ? (failure === 'forced-stop' ? 137 : failure === 'graceful-timeout' ? 1 : 0) : 0;
  process.stdout.write(JSON.stringify([{ Image: isNew ? (worker ? 'worker-new-id' : 'app-new-id') : 'previous-id', State: { Running: state[worker ? 'worker' : 'app'], Paused: failure === 'paused', ExitCode: exitCode, OOMKilled: false, Health: { Status: 'healthy' } }, Config: { Labels: { 'org.opencontainers.image.revision': isNew ? '${SHA}' : 'old' }, Env: Object.entries(env).map(([key, value]) => key + '=' + value) } }]));
  process.exit(0);
}
if (args[0] === 'create') { process.stdout.write('extract-container'); process.exit(0); }
if (args[0] === 'cp') {
  fail('migration');
  const source = args[1].split(':/app/')[1];
  if (source.includes('0416_meta_native_platform')) fail('native-migration');
  fs.copyFileSync(path.join(process.env.IRB_REPO, source), args[2]);
  process.exit(0);
}
if (args[0] === 'rm') process.exit(0);
if (args[0] === 'stop') { fail('stop'); state.worker = false; save(); process.exit(0); }
if (args[0] === 'compose') {
  if (args.includes('ps')) { process.stdout.write(args.at(-1) === 'worker' ? 'worker-container' : 'app-container'); process.exit(0); }
  if (args.includes('stop')) { state.worker = false; save(); process.exit(0); }
  if (args.includes('up')) {
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'root', 'compose.json'), 'utf8'));
    const services = args.filter((arg) => ['app', 'worker'].includes(arg));
    const isNew = config.services.app.image.includes('@sha256:');
    if (isNew) fail(services.includes('worker') ? 'worker-up' : 'app-up');
    else fail('rollback');
    for (const service of services) state[service] = true;
    state.changed = isNew;
    save(); process.exit(0);
  }
}
if (args[0] === 'exec') {
  if (args.includes('pg_dump')) { fail('backup'); process.stdout.write('isolated dump'); process.exit(0); }
  if (args.includes('psql')) {
    const sql = fs.readFileSync(0, 'utf8');
    fs.appendFileSync(path.join(dir, 'sql.txt'), sql);
    if (sql.startsWith('-- 0415 contract')) {
      process.stdout.write(failure === 'incompatible' ? 'incompatible' : (failure === 'existing' || state.migration ? 'ready' : 'missing'));
      process.exit(0);
    }
    if (sql.startsWith('-- 0416 contract:')) {
      process.stdout.write(failure === 'native-incompatible' ? 'incompatible' : failure === 'native-dependencies' ? 'dependencies_missing' : (failure === 'existing' || failure === 'native-existing' || state.nativeMigration ? 'ready' : 'missing'));
      process.exit(0);
    }
    if (sql.includes('create function public.fn_meta_app_configure')) {
      fail('native-sql'); state.nativeMigration = true; save();
    }
    if (sql.includes('create function public.automatico_da_prospeccao')) {
      fail('sql'); state.migration = true; save();
      if (failure === 'signal') process.kill(process.ppid, 'SIGTERM');
    }
    process.exit(0);
  }
  if (args.includes('node')) {
    if (failure === 'worker-health') process.exit(1);
    process.exit(0);
  }
}
process.stderr.write('Unknown docker fixture command: ' + args.join(' ') + '\\n');
process.exit(1);
`, { mode: 0o755 });
  writeFileSync(join(dir, "bin", "curl"), `#!/usr/bin/env node
if (['app-health', 'rollback'].includes(process.env.IRB_FAILURE)) process.exit(1);
if (!process.argv.some((arg) => arg.includes('/health'))) process.exit(0);
process.stdout.write(JSON.stringify({ data: { status: 'healthy', version: process.env.IRB_FAILURE === 'app-version' ? 'wrong' : '${SHA}' } }));
`, { mode: 0o755 });
  for (const command of ["flock", "sleep"]) writeFileSync(join(dir, "bin", command), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const script = readFileSync("scripts/deploy-irb.sh", "utf8")
    .replaceAll("/opt/backups/escreveai", join(dir, "backups"))
    .replaceAll("/opt/escreveai", join(dir, "root"))
    .replace("/run/lock/escreveai-deploy.lock", join(dir, "deploy.lock"))
    // Accelerate polling only; the deployed health/identity functions stay intact.
    .replace("for attempt in {1..40}", "for attempt in {1..2}");
  writeFileSync(join(dir, "deploy.sh"), script);
  const result = spawnSync("bash", [join(dir, "deploy.sh"), ...args], {
    encoding: "utf8", timeout: 15_000,
    env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, IRB_FIXTURE: dir, IRB_FAILURE: failure, IRB_REPO: process.cwd() },
  });
  const calls = (() => { try { return readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]); } catch { return []; } })();
  return { result, calls, config: JSON.parse(readFileSync(join(dir, "root", "compose.json"), "utf8")), state: JSON.parse(readFileSync(join(dir, "state.json"), "utf8")), sql: (() => { try { return readFileSync(join(dir, "sql.txt"), "utf8"); } catch { return ""; } })() };
}

describe("IRB deploy executes the approved app and worker together", () => {
  it("rejects mutable or malformed arguments before touching Docker", () => {
    for (const args of [["latest", APP_DIGEST, WORKER_DIGEST], [SHA, "bad", WORKER_DIGEST], [SHA, APP_DIGEST, WORKER_DIGEST, "extra"]]) {
      const proof = deployment("", true, args);
      expect(proof.result.status).not.toBe(0);
      expect(proof.calls).toEqual([]);
    }
  });
  it.each(["backup", "pull", "digest", "revision", "image-version", "migration", "native-migration", "native-incompatible", "native-dependencies", "paused", "incompatible"])("%s failure leaves the live services unchanged", (failure) => {
    const proof = deployment(failure);
    expect(proof.result.status).not.toBe(0);
    expect(proof.config).toEqual(previous);
    expect(proof.state.worker).toBe(true);
    expect(proof.calls.some((call) => call[0] === "stop")).toBe(false);
  });
  it.each(["stop", "forced-stop", "graceful-timeout", "sql", "native-sql", "signal", "config", "app-up", "worker-up", "app-health", "app-version", "worker-health", "worker-version"])("%s failure restores both images and the previously active worker", (failure) => {
    const proof = deployment(failure);
    expect(proof.result.status, proof.result.stdout + proof.result.stderr).not.toBe(0);
    expect(proof.config).toEqual(previous);
    expect(proof.state.worker).toBe(true);
    expect(proof.state.app).toBe(true);
    expect(proof.calls.some((call) => call.includes("up") && call.includes("worker"))).toBe(true);
    expect(proof.result.stderr).toContain("restoring previous app and worker");
    if (["forced-stop", "graceful-timeout"].includes(failure)) expect(proof.sql).not.toContain("create function public.automatico_da_prospeccao");
  });
  it("extracts reviewed 0415 and 0416 without starting the container, drains the worker and preserves unrelated configuration", () => {
    const proof = deployment();
    expect(proof.result.status, proof.result.stdout + proof.result.stderr).toBe(0);
    const expected = structuredClone(previous);
    expected.services.app.image = APP;
    expected.services.worker.image = WORKER;
    expected.services.app.environment.APP_VERSION = SHA;
    expected.services.worker.environment.APP_VERSION = SHA;
    expect(proof.config).toEqual(expected);
    expect(proof.calls.some((call) => call[0] === "start" || call[0] === "run")).toBe(false);
    const paused = proof.calls.findIndex((call) => call[0] === "stop");
    const applied = proof.calls.findIndex((call) => call.includes("psql") && call.includes("-1"));
    const appUp = proof.calls.findIndex((call) => call.includes("up") && call.includes("app"));
    expect(paused).toBeLessThan(applied);
    expect(applied).toBeLessThan(appUp);
    expect(proof.calls[applied]).toEqual(expect.arrayContaining(["-X", "-1", "ON_ERROR_STOP=1"]));
    expect(proof.sql).toContain("create function public.automatico_da_prospeccao");
    expect(proof.sql).toContain("create function public.fn_meta_app_configure");
    expect(proof.sql).toContain("create table public.meta_connections");
    expect(proof.state.nativeMigration).toBe(true);
    expect(proof.sql).not.toContain("create or replace function");
    expect(proof.sql).not.toContain("CREATE TABLE");
    expect(proof.calls.flat().some((arg) => /voice|scheduler/.test(arg))).toBe(false);
    expect(proof.state.worker).toBe(true);
  });
  it("does not activate a worker that was previously stopped", () => {
    const proof = deployment("", false);
    expect(proof.result.status, proof.result.stdout + proof.result.stderr).toBe(0);
    expect(proof.state.worker).toBe(false);
    expect(proof.calls.some((call) => call.includes("up") && call.includes("worker"))).toBe(false);
  });
  it("preserves an existing compatible function, including future forward fixes", () => {
    const proof = deployment("existing");
    expect(proof.result.status, proof.result.stdout + proof.result.stderr).toBe(0);
    expect(proof.sql).not.toContain("create function");
    expect(proof.sql).not.toContain("create or replace function");
    expect(proof.calls.some((call) => call.includes("psql") && call.includes("-1"))).toBe(false);
    expect(proof.state.worker).toBe(true);
  });
  it("preserves an installed compatible Meta schema while installing only missing 0415", () => {
    const proof = deployment("native-existing");
    expect(proof.result.status, proof.result.stdout + proof.result.stderr).toBe(0);
    expect(proof.sql).toContain("create function public.automatico_da_prospeccao");
    expect(proof.sql).not.toContain("create function public.fn_meta_");
    expect(proof.sql).not.toContain("create table public.meta_");
  });
  it("reports a rollback failure instead of claiming services were restored", () => {
    const proof = deployment("rollback");
    expect(proof.result.status).not.toBe(0);
    expect(proof.result.stderr).toContain("operator intervention required");
    expect(proof.result.stderr).not.toContain("Previous configuration and worker running state restored");
  });
});

it("the forced SSH command accepts exactly three immutable values without shell evaluation", () => {
  const dir = mkdtempSync(join(tmpdir(), "irb-command-"));
  dirs.push(dir);
  writeFileSync(join(dir, "sudo"), '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n', { mode: 0o755 });
  function call(command: string) {
    return spawnSync("bash", ["scripts/deploy-irb-command.sh"], {
      encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, SSH_ORIGINAL_COMMAND: command },
    });
  }
  const valid = call(`${SHA} ${APP_DIGEST} ${WORKER_DIGEST}`);
  expect(valid.status).toBe(0);
  expect(JSON.parse(valid.stdout)).toEqual(["-n", "/opt/escreveai/deploy-live.sh", SHA, APP_DIGEST, WORKER_DIGEST]);
  for (const wrong of [SHA, `latest ${APP_DIGEST} ${WORKER_DIGEST}`, `${SHA} ${APP_DIGEST} ${WORKER_DIGEST}; echo executed`, `${SHA} ${APP_DIGEST} ${WORKER_DIGEST}\necho executed`, `$(echo ${SHA}) ${APP_DIGEST} ${WORKER_DIGEST}`]) {
    const invalid = call(wrong);
    expect(invalid.status).toBe(2);
    expect(invalid.stdout).toBe("");
  }
});
