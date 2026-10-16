import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";

const SHA = "a".repeat(40);
const APP_DIGEST = `sha256:${"b".repeat(64)}`;
const WORKER_DIGEST = `sha256:${"c".repeat(64)}`;
const APP = `ghcr.io/saraivabr/deskcomm-app@${APP_DIGEST}`;
const WORKER = `ghcr.io/saraivabr/deskcomm-worker@${WORKER_DIGEST}`;
const DIRECT_WORKER = ["node", "--import", "tsx", "workers/agent-worker/main.ts"];
const previous = {
  services: {
    app: {
      image: "app:previous",
      environment: { APP_VERSION: "old", KEEP: "literal $value" },
      command: ["node", "server.js"],
    },
    worker: {
      image: "worker:previous",
      environment: { APP_VERSION: "old", KEEP: "worker" },
      command: ["pnpm", "exec", "tsx", "workers/agent-worker/main.ts"],
    },
    "voice-worker": { image: "voice:previous", environment: { KEEP: "voice" } },
    scheduler: { image: "scheduler:previous", command: ["original", "cron"] },
  },
};
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function deployment(
  failure = "",
  active = true,
  args = [SHA, APP_DIGEST, WORKER_DIGEST],
  options: {
    command?: string[];
    entrypoint?: string[];
    restart?: { Name: string; MaximumRetryCount: number };
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "irb-deploy-"));
  dirs.push(dir);
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "root"));
  const initial = structuredClone(previous);
  if (options.command) initial.services.worker.command = options.command;
  if (options.entrypoint) Object.assign(initial.services.worker, { entrypoint: options.entrypoint });
  writeFileSync(join(dir, "root", "compose.json"), JSON.stringify(initial));
  if (failure === "config") mkdirSync(join(dir, "root", "compose.json.tmp"));
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({
      worker: active, workerId: "worker-container", app: true, changed: false,
      restartPolicy: options.restart ?? { Name: "unless-stopped", MaximumRetryCount: 0 },
    }),
  );
  writeFileSync(
    join(dir, "bin", "docker"),
    `#!/usr/bin/env node
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
  process.stdout.write(JSON.stringify([{ Id: worker ? 'worker-new-id' : 'app-new-id', RepoDigests: failure === 'digest' ? [] : [ref], Config: { Cmd: worker ? (failure === 'image-command' ? ['pnpm', 'exec', 'tsx', 'workers/agent-worker/main.ts'] : ${JSON.stringify(DIRECT_WORKER)}) : ['node', 'server.js'], Entrypoint: failure === 'image-entrypoint' ? ['custom-wrapper'] : ['docker-entrypoint.sh'], Labels: { 'org.opencontainers.image.revision': revision }, Env: ['APP_VERSION=' + (failure === 'image-version' ? 'wrong' : '${SHA}')] } }]));
  process.exit(0);
}
if (args[0] === 'inspect') {
  const id = args.find((arg) => ['app-container', 'worker-container', 'worker-new-container', 'worker-restored-container'].includes(arg));
  if (!id) process.exit(1);
  const worker = id !== 'app-container';
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'root', 'compose.json'), 'utf8')).services[worker ? 'worker' : 'app'];
  const isNew = config.image.includes('@sha256:');
  const env = { ...config.environment };
  if (worker && isNew && failure === 'worker-version') env.APP_VERSION = 'wrong';
  const exitCode = !state.worker ? (failure === 'forced-stop' ? 137 : failure === 'graceful-timeout' ? 1 : 0) : 0;
  process.stdout.write(JSON.stringify([{ Image: isNew ? (worker ? 'worker-new-id' : 'app-new-id') : 'previous-id', State: { Running: state[worker ? 'worker' : 'app'], Paused: failure === 'paused', ExitCode: exitCode, OOMKilled: failure === 'oom-stop', Health: { Status: 'healthy' } }, HostConfig: { RestartPolicy: state.restartPolicy }, Config: { Cmd: config.command, Entrypoint: config.entrypoint ?? ['docker-entrypoint.sh'], Labels: { 'org.opencontainers.image.revision': isNew ? '${SHA}' : 'old' }, Env: Object.entries(env).map(([key, value]) => key + '=' + value) } }]));
  process.exit(0);
}
if (args[0] === 'create') { process.stdout.write('extract-container'); process.exit(0); }
if (args[0] === 'cp') {
  fail('migration');
  const source = args[1].split(':/app/')[1];
  if (source.includes('0416_meta_native_platform')) fail('native-migration');
  if (source.includes('0417_meta_privacy_lifecycle')) fail('privacy-migration');
  if (source.includes('0418_meta_social_messaging')) fail('messaging-migration');
  if (source.includes('upstream-release.json')) fail('release-artifact');
  fs.copyFileSync(path.join(process.env.IRB_REPO, source), args[2]);
  if (source.includes('_0420_') && failure === 'release-checksum') fs.appendFileSync(args[2], '\\n-- changed');
  process.exit(0);
}
if (args[0] === 'rm') process.exit(0);
if (args[0] === 'stop') { fail('stop'); state.worker = false; save(); process.exit(0); }
if (args[0] === 'update') {
  const [Name, retries] = args[2].split(':');
  state.restartPolicy = { Name, MaximumRetryCount: Number(retries || 0) }; save();
  if (Name === 'no') fail('restart-update');
  process.exit(0);
}
if (args[0] === 'wait') {
  if (failure === 'legacy-timeout') { setInterval(() => {}, 1000); return; }
  process.stdout.write(failure === 'forced-stop' ? '137' : failure === 'graceful-timeout' ? '1' : '0');
  process.exit(0);
}
if (args[0] === 'compose') {
  if (args.includes('ps')) { process.stdout.write(args.at(-1) === 'worker' ? state.workerId : 'app-container'); process.exit(0); }
  if (args.includes('stop')) { state.worker = false; save(); process.exit(0); }
  if (args.includes('up')) {
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'root', 'compose.json'), 'utf8'));
    const services = args.filter((arg) => ['app', 'worker'].includes(arg));
    const isNew = config.services.app.image.includes('@sha256:');
    if (isNew) fail(services.includes('worker') ? 'worker-up' : 'app-up');
    else fail('rollback');
    for (const service of services) state[service] = true;
    // Reuse on rollback intentionally does NOT undo docker update.
    if (services.includes('worker') && (isNew || state.workerId !== 'worker-container')) {
      state.workerId = isNew ? 'worker-new-container' : 'worker-restored-container';
      state.restartPolicy = { Name: 'unless-stopped', MaximumRetryCount: 0 };
    }
    state.changed = isNew;
    save(); process.exit(0);
  }
}
if (args[0] === 'exec') {
  if (args.includes('pg_dump')) { fail('backup'); process.stdout.write('isolated dump'); process.exit(0); }
  if (args.includes('psql')) {
    const sql = fs.readFileSync(0, 'utf8');
    fs.appendFileSync(path.join(dir, 'sql.txt'), sql);
    if (sql.startsWith('-- escreve.ai stable release preflight')) {
      fail('release-preflight'); process.stdout.write('ready'); process.exit(0);
    }
    if (sql.startsWith('-- escreve.ai stable release apply')) {
      if (!args.includes('-1')) process.exit(1);
      fail('release-sql'); state.releaseApplied = true; save();
      process.stdout.write('ready'); process.exit(0);
    }
    if (sql.startsWith('-- escreve.ai stable release verify')) {
      fail('release-verify'); process.stdout.write(state.releaseApplied ? 'ready' : 'missing'); process.exit(0);
    }
    if (sql.startsWith('-- 0415 contract')) {
      process.stdout.write(failure === 'incompatible' ? 'incompatible' : (failure === 'existing' || failure.startsWith('messaging-') || state.migration ? 'ready' : 'missing'));
      process.exit(0);
    }
    if (sql.startsWith('-- 0416 contract:')) {
      process.stdout.write(failure === 'native-incompatible' ? 'incompatible' : failure === 'native-dependencies' ? 'dependencies_missing' : (failure === 'existing' || failure.startsWith('messaging-') || failure === 'native-existing' || state.nativeMigration ? 'ready' : 'missing'));
      process.exit(0);
    }
    if (sql.startsWith('-- 0417 contract:')) {
      const nativeReady = failure === 'existing' || failure === 'native-existing' || state.nativeMigration;
      let result = failure === 'existing' || failure.startsWith('messaging-') || state.privacyMigration ? 'ready' : nativeReady ? 'missing' : 'dependencies_missing';
      if (failure === 'privacy-incompatible') result = 'incompatible';
      if (failure === 'privacy-partial') result = 'partial';
      if (failure === 'privacy-dependencies' && nativeReady) result = 'dependencies_missing';
      if (failure === 'privacy-concurrent' && nativeReady) result = 'ready';
      state.privacyChecks = [...(state.privacyChecks || []), {nativeReady, result}]; save();
      process.stdout.write(result); process.exit(0);
    }
    if (sql.startsWith('-- 0418 deploy gate.')) {
      const dependenciesReady = failure === 'existing' || failure.startsWith('messaging-') || state.privacyMigration;
      let result = failure === 'existing' || failure === 'messaging-ready' || state.messagingMigration ? 'ready' : dependenciesReady ? 'missing' : 'dependencies_missing';
      if (failure === 'messaging-partial') result = 'partial';
      if (['messaging-incompatible', 'messaging-unsafe-acl', 'messaging-unknown-core-preflight'].includes(failure)) result = 'incompatible';
      if (failure === 'messaging-dependencies') result = 'dependencies_missing';
      if (failure === 'messaging-concurrent' && state.messagingChecks?.length) result = 'ready';
      if (failure === 'messaging-recheck' && state.messagingMigration) result = 'incompatible';
      state.messagingChecks = [...(state.messagingChecks || []), {dependenciesReady, result}]; save();
      process.stdout.write(result); process.exit(0);
    }
    if (sql.includes('create function public.fn_meta_app_configure')) {
      fail('native-sql'); state.nativeMigration = true; save();
    }
    if (sql.includes('create function public.fn_meta_privacy_request')) {
      fail('privacy-sql'); state.privacyMigration = true; save();
    }
    if (sql.includes('create function public.fn_meta_messaging_accept')) {
      fail('messaging-sql'); fail('messaging-unknown-core'); state.messagingMigration = true; save();
    }
    if (sql.includes('create function public.automatico_da_prospeccao')) {
      fail('sql'); state.migration = true; save();
      if (failure === 'signal') process.kill(process.ppid, 'SIGTERM');
    }
    process.exit(0);
  }
  if (args.includes('node')) {
    if (args.includes('inspect')) { fail('legacy-process'); process.stdout.write('{"pid":42,"start":"123"}'); process.exit(0); }
    if (args.includes('signal')) {
      fail('stop'); fail('legacy-signal');
      if (failure !== 'legacy-timeout') state.worker = false;
      save(); process.exit(0);
    }
    if (failure === 'worker-health') process.exit(1);
    process.exit(0);
  }
}
process.stderr.write('Unknown docker fixture command: ' + args.join(' ') + '\\n');
process.exit(1);
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(dir, "bin", "curl"),
    `#!/usr/bin/env node
if (['app-health', 'rollback'].includes(process.env.IRB_FAILURE)) process.exit(1);
if (!process.argv.some((arg) => arg.includes('/health'))) process.exit(0);
process.stdout.write(JSON.stringify({ data: { status: 'healthy', version: process.env.IRB_FAILURE === 'app-version' ? 'wrong' : '${SHA}' } }));
`,
    { mode: 0o755 },
  );
  for (const command of ["flock", "sleep"])
    writeFileSync(join(dir, "bin", command), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const script = readFileSync("scripts/deploy-irb.sh", "utf8")
    .replaceAll("/opt/backups/escreveai", join(dir, "backups"))
    .replaceAll("/opt/escreveai", join(dir, "root"))
    .replace("/run/lock/escreveai-deploy.lock", join(dir, "deploy.lock"))
    // Accelerate polling only; the deployed health/identity functions stay intact.
    .replace("for attempt in {1..40}", "for attempt in {1..2}")
    .replace("timeout=int(sys.argv[2])", "timeout=min(1, int(sys.argv[2]))");
  writeFileSync(join(dir, "deploy.sh"), script);
  const result = spawnSync("bash", [join(dir, "deploy.sh"), ...args], {
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...process.env,
      PATH: `${join(dir, "bin")}:${process.env.PATH}`,
      IRB_FIXTURE: dir,
      IRB_FAILURE: failure,
      IRB_REPO: process.cwd(),
    },
  });
  const calls = (() => {
    try {
      return readFileSync(join(dir, "calls.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
    } catch {
      return [];
    }
  })();
  return {
    result,
    calls,
    config: JSON.parse(readFileSync(join(dir, "root", "compose.json"), "utf8")),
    state: JSON.parse(readFileSync(join(dir, "state.json"), "utf8")),
    sql: (() => {
      try {
        return readFileSync(join(dir, "sql.txt"), "utf8");
      } catch {
        return "";
      }
    })(),
  };
}

describe("IRB deploy executes the approved app and worker together", () => {
  it("validates the explicit release before stopping and applies it atomically before changing images", () => {
    const proof = deployment("existing", true, undefined, { command: DIRECT_WORKER });
    expect(proof.result.status, proof.result.stderr).toBe(0);
    expect(proof.state.releaseApplied).toBe(true);
    const pause = proof.calls.findIndex((call) => call[0] === "stop");
    const transactions = proof.calls.map((call, i) => ({ call, i }))
      .filter(({ call }) => call.includes("psql") && call.includes("-1"));
    expect(transactions).toHaveLength(1);
    expect(transactions[0].i).toBeGreaterThan(pause);
    expect(transactions[0].i).toBeLessThan(proof.calls.findIndex((call) => call.includes("up")));
    expect(proof.sql).toContain("-- escreve.ai stable release preflight");
    expect(proof.sql).toContain("escreveai_ops.schema_releases");
    expect(proof.sql).toContain("-- escreve.ai stable release verify");
  });

  it("keeps docker stop for the direct Node command without changing restart policy", () => {
    const proof = deployment("", true, undefined, { command: DIRECT_WORKER });
    expect(proof.result.status, proof.result.stderr).toBe(0);
    expect(proof.calls.some((call) => call[0] === "stop")).toBe(true);
    expect(proof.calls.some((call) => call[0] === "update" || call.includes("signal"))).toBe(false);
  });
  it.each([
    { command: ["node", "custom-worker.js"] },
    { entrypoint: ["custom-wrapper"] },
  ])("rejects custom worker execution before stopping or changing it", (options) => {
    const proof = deployment("", true, undefined, options);
    expect(proof.result.status).not.toBe(0);
    expect(proof.state.worker).toBe(true);
    expect(proof.calls.some((call) => call[0] === "stop" || call[0] === "update" || call.includes("signal"))).toBe(false);
    if (options.command) expect(proof.config.services.worker.command).toEqual(options.command);
    if (options.entrypoint) expect(proof.config.services.worker.entrypoint).toEqual(options.entrypoint);
  });
  it("restores on-failure retries explicitly when rollback reuses the stopped legacy container", () => {
    const restart = { Name: "on-failure", MaximumRetryCount: 7 };
    const proof = deployment("sql", true, undefined, { restart });
    expect(proof.result.status).not.toBe(0);
    expect(proof.state.restartPolicy).toEqual(restart);
    expect(proof.calls).toContainEqual(["update", "--restart", "on-failure:7", "worker-container"]);
    const restore = proof.calls.findIndex((call) => call[0] === "update" && call[2] === "on-failure:7");
    const resume = proof.calls.findIndex((call) => call.includes("up") && call.includes("worker"));
    expect(restore).toBeLessThan(resume);
    expect(proof.state.worker).toBe(true);
  });
  it("restores the captured runtime policy after rollback recreates the worker with another ID", () => {
    const restart = { Name: "on-failure", MaximumRetryCount: 7 };
    const proof = deployment("worker-health", true, undefined, { restart });
    expect(proof.result.status).not.toBe(0);
    expect(proof.state.workerId).toBe("worker-restored-container");
    expect(proof.state.restartPolicy).toEqual(restart);
    expect(proof.calls).toContainEqual(["update", "--restart", "on-failure:7", "worker-restored-container"]);
    expect(proof.state.worker).toBe(true);
  });
  it("rejects mutable or malformed arguments before touching Docker", () => {
    for (const args of [
      ["latest", APP_DIGEST, WORKER_DIGEST],
      [SHA, "bad", WORKER_DIGEST],
      [SHA, APP_DIGEST, WORKER_DIGEST, "extra"],
    ]) {
      const proof = deployment("", true, args);
      expect(proof.result.status).not.toBe(0);
      expect(proof.calls).toEqual([]);
    }
  });
  it.each([
    "backup",
    "pull",
    "digest",
    "revision",
    "image-version",
    "image-command",
    "image-entrypoint",
    "legacy-process",
    "migration",
    "native-migration",
    "privacy-migration",
    "messaging-migration",
    "release-artifact",
    "release-checksum",
    "release-preflight",
    "messaging-partial",
    "messaging-incompatible",
    "messaging-unsafe-acl",
    "messaging-unknown-core-preflight",
    "messaging-dependencies",
    "privacy-incompatible",
    "privacy-partial",
    "native-incompatible",
    "native-dependencies",
    "paused",
    "incompatible",
  ])("%s failure leaves the live services unchanged", (failure) => {
    const proof = deployment(failure);
    expect(proof.result.status).not.toBe(0);
    expect(proof.config).toEqual(previous);
    expect(proof.state.worker).toBe(true);
    expect(proof.calls.some((call) => call[0] === "stop")).toBe(false);
  });
  it.each([
    "stop",
    "forced-stop",
    "graceful-timeout",
    "oom-stop",
    "legacy-signal",
    "legacy-timeout",
    "restart-update",
    "sql",
    "native-sql",
    "privacy-sql",
    "messaging-sql",
    "release-sql",
    "release-verify",
    "messaging-concurrent",
    "messaging-unknown-core",
    "messaging-recheck",
    "privacy-dependencies",
    "privacy-concurrent",
    "signal",
    "config",
    "app-up",
    "worker-up",
    "app-health",
    "app-version",
    "worker-health",
    "worker-version",
  ])("%s failure restores both images and the previously active worker", (failure) => {
    const proof = deployment(failure);
    expect(
      proof.result.status,
      proof.result.stdout + proof.result.stderr + JSON.stringify(proof.state),
    ).not.toBe(0);
    expect(proof.config).toEqual(previous);
    expect(proof.state.worker).toBe(true);
    expect(proof.state.app).toBe(true);
    expect(proof.state.restartPolicy).toEqual({ Name: "unless-stopped", MaximumRetryCount: 0 });
    expect(proof.calls.some((call) => call.includes("up") && call.includes("worker"))).toBe(true);
    expect(proof.result.stderr).toContain("restoring previous app and worker");
    if (["forced-stop", "graceful-timeout", "oom-stop", "legacy-signal", "legacy-timeout", "restart-update"].includes(failure))
      expect(proof.sql).not.toContain("create function public.automatico_da_prospeccao");
  });
  it("extracts reviewed 0415–0418 without starting the container, drains the worker and preserves unrelated configuration", () => {
    const proof = deployment();
    expect(proof.result.status, proof.result.stdout + proof.result.stderr).toBe(0);
    const expected = structuredClone(previous);
    expected.services.app.image = APP;
    expected.services.worker.image = WORKER;
    expected.services.app.environment.APP_VERSION = SHA;
    expected.services.worker.environment.APP_VERSION = SHA;
    expected.services.worker.command = DIRECT_WORKER;
    expect(proof.config).toEqual(expected);
    expect(proof.calls.some((call) => call[0] === "start" || call[0] === "run")).toBe(false);
    const paused = proof.calls.findIndex((call) => call.includes("signal"));
    expect(proof.calls.some((call) => call[0] === "stop")).toBe(false);
    expect(proof.calls.findIndex((call) => call[0] === "update" && call[2] === "no")).toBeLessThan(paused);
    const applied = proof.calls.findIndex((call) => call.includes("psql") && call.includes("-1"));
    const appUp = proof.calls.findIndex((call) => call.includes("up") && call.includes("app"));
    expect(paused).toBeLessThan(applied);
    expect(applied).toBeLessThan(appUp);
    expect(proof.calls[applied]).toEqual(expect.arrayContaining(["-X", "-1", "ON_ERROR_STOP=1"]));
    expect(proof.sql).toContain("create function public.automatico_da_prospeccao");
    expect(proof.sql).toContain("create function public.fn_meta_app_configure");
    expect(proof.sql).toContain("create table public.meta_connections");
    expect(proof.state.nativeMigration).toBe(true);
    expect(proof.state.privacyMigration).toBe(true);
    expect(proof.state.messagingMigration).toBe(true);
    expect(proof.state.releaseApplied).toBe(true);
    expect(proof.sql).toContain("create function public.fn_meta_privacy_request");
    expect(proof.sql).toContain("create table public.meta_privacy_subjects");
    expect(proof.sql).not.toContain("create or replace function public.fn_meta_privacy_");
    expect(proof.sql).toContain("meta_privacy_known_core");
    expect(proof.sql).toContain("create function public.fn_meta_messaging_accept");
    expect(proof.sql).not.toContain("create or replace function public.fn_meta_messaging_");
    expect(proof.sql).toContain("add column meta_social_asset_id");
    expect(proof.sql).toContain(
      "create unique index channel_sessions_meta_social_external_active_unique",
    );
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
    expect(proof.sql).not.toMatch(/create (?:or replace )?function public\.(automatico_da_prospeccao|fn_meta_)/);
    expect(proof.calls.filter((call) => call.includes("psql") && call.includes("-1"))).toHaveLength(1);
    expect(proof.state.releaseApplied).toBe(true);
    expect(proof.state.worker).toBe(true);
  });
  it("preserves an installed compatible Meta schema while installing only missing 0415", () => {
    const proof = deployment("native-existing");
    expect(proof.result.status, proof.result.stdout + proof.result.stderr).toBe(0);
    expect(proof.sql).toContain("create function public.automatico_da_prospeccao");
    expect(proof.sql).not.toContain("create function public.fn_meta_app_configure");
    expect(proof.sql).not.toContain("create table public.meta_connections");
    expect(proof.sql).toContain("create function public.fn_meta_privacy_request");
  });
  it("installs only missing messaging on a recovered database after draining, then checks ready before app handoff", () => {
    const proof = deployment("messaging-missing");
    expect(proof.result.status, proof.result.stdout + proof.result.stderr).toBe(0);
    expect(proof.sql).toContain("create function public.fn_meta_messaging_accept");
    expect(proof.sql).not.toContain("create function public.fn_meta_privacy_request");
    expect(proof.sql).not.toContain("create function public.fn_meta_app_configure");
    expect(proof.sql).not.toContain("create function public.automatico_da_prospeccao");
    expect(proof.state.messagingChecks.map((check: { result: string }) => check.result)).toEqual([
      "missing",
      "missing",
      "ready",
    ]);
    const stopped = proof.calls.findIndex((call) => call.includes("signal"));
    const applied = proof.calls.findIndex((call) => call.includes("psql") && call.includes("-1"));
    const appUp = proof.calls.findIndex((call) => call.includes("up") && call.includes("app"));
    expect(stopped).toBeLessThan(applied);
    expect(applied).toBeLessThan(appUp);
    // One transaction installs 0418; the second installs the stable release.
    expect(proof.calls.filter((call) => call.includes("psql") && call.includes("-1"))).toHaveLength(2);
  });
  it("preserves a ready messaging contract while installing no recovered schema", () => {
    const proof = deployment("messaging-ready");
    expect(proof.result.status, proof.result.stdout + proof.result.stderr).toBe(0);
    expect(proof.sql).not.toMatch(/create (?:or replace )?function public\.(automatico_da_prospeccao|fn_meta_)/);
    expect(proof.calls.filter((call) => call.includes("psql") && call.includes("-1"))).toHaveLength(1);
    expect(proof.state.releaseApplied).toBe(true);
  });
  it("reports a rollback failure instead of claiming services were restored", () => {
    const proof = deployment("rollback");
    expect(proof.result.status).not.toBe(0);
    expect(proof.result.stderr).toContain("operator intervention required");
    expect(proof.result.stderr).not.toContain(
      "Previous configuration and worker running state restored",
    );
  });
});

describe("legacy shutdown identifies the complete process chain", () => {
  const helper = (() => {
    const source = readFileSync("scripts/deploy-irb.sh", "utf8")
      .split("<<'LEGACY'\n")[1]?.split("\nLEGACY\n")[0];
    if (!source) throw new Error("Legacy shutdown helper is missing");
    return source;
  })();
  const worker = "workers/agent-worker/main.ts";
  function processes() {
    return new Map([
      [1, { args: ["node", "/usr/local/bin/pnpm", "exec", "tsx", worker], parent: 0, start: "10" }],
      [18, { args: ["node", "./node_modules/.bin/../tsx/dist/cli.mjs", worker], parent: 1, start: "20" }],
      [34, { args: ["/usr/local/bin/node", "--require", "/app/node_modules/.pnpm/tsx@4/node_modules/tsx/dist/preflight.cjs", "--import", "file:///app/node_modules/.pnpm/tsx@4/node_modules/tsx/dist/loader.mjs", worker], parent: 18, start: "30" }],
    ]);
  }
  function execute(tree: ReturnType<typeof processes>, mode = "inspect", expected = "") {
    let output = "";
    const signals: { pid: number; signal: string }[] = [];
    const fs = {
      readdirSync: () => [...tree.keys()].map(String),
      readlinkSync: (file: string) => file.endsWith("/cwd") ? "/app" : "/usr/local/bin/node",
      readFileSync: (file: string) => {
        const [, , id, name] = file.split("/");
        const process = tree.get(Number(id));
        if (!process) throw new Error("missing process");
        if (name === "cmdline") return process.args.join("\0") + "\0";
        const stat = Array<string>(20).fill("0");
        stat[0] = "S"; stat[1] = String(process.parent); stat[19] = process.start;
        return `${id} (node) ${stat.join(" ")}`;
      },
    };
    runInNewContext(helper, {
      require: (name: string) => name === "node:fs" ? fs : { basename: (value: string) => value.split("/").at(-1), resolve: (...parts: string[]) => join(...parts) },
      process: { argv: ["node", "-", mode, expected], stdout: { write: (value: string) => { output += value; } }, kill: (pid: number, signal: string) => signals.push({ pid, signal }) },
    });
    return { output, signals };
  }
  it("signals only the verified final Node, never pnpm or tsx", () => {
    const tree = processes();
    const identity = execute(tree).output;
    expect(execute(tree, "signal", identity).signals).toEqual([{ pid: 34, signal: "SIGTERM" }]);
  });
  it.each(["missing", "ambiguous", "foreign-parent", "custom-root", "wrong-script"])("rejects %s process trees", (change) => {
    const tree = processes();
    if (change === "missing") tree.delete(34);
    if (change === "ambiguous") tree.set(35, { ...tree.get(34)! });
    if (change === "foreign-parent") tree.get(18)!.parent = 99;
    if (change === "custom-root") tree.get(1)!.args[1] = "/usr/local/bin/custom";
    if (change === "wrong-script") tree.get(34)!.args[5] = "other-worker.ts";
    expect(() => execute(tree)).toThrow();
  });
  it("rejects PID reuse between discovery and signalling", () => {
    const tree = processes();
    const identity = execute(tree).output;
    tree.get(34)!.start = "changed";
    expect(() => execute(tree, "signal", identity)).toThrow("changed before shutdown");
  });
});

it("the forced SSH command accepts exactly three immutable values without shell evaluation", () => {
  const dir = mkdtempSync(join(tmpdir(), "irb-command-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "sudo"),
    "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
    { mode: 0o755 },
  );
  function call(command: string) {
    return spawnSync("bash", ["scripts/deploy-irb-command.sh"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, SSH_ORIGINAL_COMMAND: command },
    });
  }
  const valid = call(`${SHA} ${APP_DIGEST} ${WORKER_DIGEST}`);
  expect(valid.status).toBe(0);
  expect(JSON.parse(valid.stdout)).toEqual([
    "-n",
    "/opt/escreveai/deploy-live.sh",
    SHA,
    APP_DIGEST,
    WORKER_DIGEST,
  ]);
  for (const wrong of [
    SHA,
    `latest ${APP_DIGEST} ${WORKER_DIGEST}`,
    `${SHA} ${APP_DIGEST} ${WORKER_DIGEST}; echo executed`,
    `${SHA} ${APP_DIGEST} ${WORKER_DIGEST}\necho executed`,
    `$(echo ${SHA}) ${APP_DIGEST} ${WORKER_DIGEST}`,
  ]) {
    const invalid = call(wrong);
    expect(invalid.status).toBe(2);
    expect(invalid.stdout).toBe("");
  }
});
