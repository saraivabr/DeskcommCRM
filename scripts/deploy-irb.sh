#!/usr/bin/env bash
# Installed root-owned at /opt/escreveai/deploy-live.sh on the production host.
set -euo pipefail
[[ $# -eq 3 && "$1" =~ ^[a-f0-9]{40}$ && "$2" =~ ^sha256:[a-f0-9]{64}$ && "$3" =~ ^sha256:[a-f0-9]{64}$ ]] || {
  echo 'Expected immutable revision, app digest and worker digest' >&2
  exit 2
}
tag=$1
app_ref="ghcr.io/saraivabr/deskcomm-app@$2"
worker_ref="ghcr.io/saraivabr/deskcomm-worker@$3"
root=/opt/escreveai
backups=/opt/backups/escreveai
compose="$root/compose.json"
exec 9>/run/lock/escreveai-deploy.lock
flock -n 9 || { echo 'Deployment already running' >&2; exit 1; }
umask 077
stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
workdir=$(mktemp -d)
rollback_needed=0
extract_container=''
worker_running=false
worker_stop_seconds=60
worker_legacy=false
worker_restart_changed=0
worker_restart_policy=no
before="$root/compose.before-$stamp.json"

service_id() { docker compose -f "$compose" ps -aq "$1"; }
service_running() {
  local id
  id=$(service_id "$1")
  [[ -n "$id" ]] || { [[ "$2" = false ]]; return; }
  docker inspect "$id" | python3 -c 'import json,sys; value=json.load(sys.stdin)[0]["State"]["Running"]; sys.exit(0 if value == (sys.argv[1] == "true") else 1)' "$2"
}
finish() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  if [[ "$rollback_needed" = 1 ]]; then
    echo 'Deployment failed; restoring previous app and worker' >&2
    local restored=0
    # Stop a candidate before returning the app to its previous revision.
    docker compose -f "$compose" stop -t "$worker_stop_seconds" worker || restored=1
    cp "$before" "$compose.rollback.tmp" && mv "$compose.rollback.tmp" "$compose" || restored=1
    # Compose can reuse the old container without undoing docker update. Restore
    # its exact policy explicitly; a recreated container uses the saved Compose.
    if [[ "$worker_restart_changed" = 1 ]]; then
      local current_worker
      current_worker=$(service_id worker) || restored=1
      if [[ "$current_worker" = "$worker_id" ]]; then
        docker update --restart "$worker_restart_policy" "$worker_id" >/dev/null || restored=1
      fi
    fi
    docker compose -f "$compose" up -d --no-deps app || restored=1
    if [[ "$worker_running" = true ]]; then
      docker compose -f "$compose" up -d --no-deps worker || restored=1
      if [[ "$worker_restart_changed" = 1 ]]; then
        current_worker=$(service_id worker) || restored=1
        if [[ -n "$current_worker" ]]; then
          docker update --restart "$worker_restart_policy" "$current_worker" >/dev/null || restored=1
        else
          restored=1
        fi
      fi
    fi
    service_running app true || restored=1
    service_running worker "$worker_running" || restored=1
    if [[ "$restored" = 0 ]]; then
      echo 'Previous configuration and worker running state restored' >&2
    else
      echo 'Rollback could not restore all service states; operator intervention required' >&2
    fi
    # Additive migrations remain installed. Never restore the live DB dump
    # automatically: doing so would discard writes made during the deployment.
    status=1
  fi
  [[ -z "$extract_container" ]] || docker rm "$extract_container" >/dev/null 2>&1
  rm -rf "$workdir"
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

app_id=$(service_id app)
worker_id=$(service_id worker)
[[ -n "$app_id" && -n "$worker_id" ]] || { echo 'App and worker containers must already exist' >&2; exit 1; }
docker inspect "$app_id" > "$workdir/app-before.json"
docker inspect "$worker_id" > "$workdir/worker-before.json"
python3 - "$compose" "$workdir/app-before.json" "$workdir/worker-before.json" > "$workdir/previous-state" <<'STATE'
import json, math, sys
config = json.load(open(sys.argv[1]))
for name in ('app', 'worker'):
    service = config['services'][name]
    if not isinstance(service.get('environment'), dict) or not isinstance(service.get('image'), str):
        raise SystemExit('Expected image and mapping environment for app and worker')
app = json.load(open(sys.argv[2]))[0]
worker = json.load(open(sys.argv[3]))[0]
legacy = ['pnpm', 'exec', 'tsx', 'workers/agent-worker/main.ts']
direct = ['node', '--import', 'tsx', 'workers/agent-worker/main.ts']
service = config['services']['worker']
if service.get('command') not in (None, legacy, direct):
    raise SystemExit('Custom worker command requires review; live configuration preserved')
if (service.get('entrypoint') not in (None, [], ['docker-entrypoint.sh']) or
    worker['Config'].get('Entrypoint') not in (None, [], ['docker-entrypoint.sh']) or
    worker['Config'].get('Cmd') not in (legacy, direct)):
    raise SystemExit('Unsupported worker command/entrypoint; live configuration preserved')
if not app['State']['Running'] or app['State'].get('Paused') or worker['State'].get('Paused'):
    raise SystemExit('Unexpected app or paused worker state; live configuration preserved')
env = dict(item.split('=', 1) for item in worker['Config']['Env'] if '=' in item)
grace = int(env.get('SHUTDOWN_GRACE_MS', '30000'))
if not 0 < grace <= 300000:
    raise SystemExit('Unsupported worker graceful shutdown timeout')
policy = worker['HostConfig']['RestartPolicy']
restart = policy.get('Name') or 'no'
retries = policy.get('MaximumRetryCount', 0)
if restart not in ('no', 'always', 'unless-stopped', 'on-failure') or not isinstance(retries, int) or retries < 0:
    raise SystemExit('Unsupported worker restart policy; live configuration preserved')
if restart == 'on-failure' and retries:
    restart += ':' + str(retries)
print(str(worker['State']['Running']).lower(), math.ceil(grace / 1000) + 30,
      str(worker['Config']['Cmd'] == legacy).lower(), restart)
STATE
read -r worker_running worker_stop_seconds worker_legacy worker_restart_policy < "$workdir/previous-state"
cp "$compose" "$before"
mkdir -p "$backups"
chmod 700 "$backups"
docker exec escreveai-db pg_dump -U postgres -d postgres -Fc > "$backups/$stamp.dump.tmp"
mv "$backups/$stamp.dump.tmp" "$backups/$stamp.dump"
docker pull "$app_ref"
docker pull "$worker_ref"
docker image inspect "$app_ref" > "$workdir/app-image.json"
docker image inspect "$worker_ref" > "$workdir/worker-image.json"
python3 - "$tag" "$app_ref" "$worker_ref" "$workdir/app-image.json" "$workdir/worker-image.json" <<'IMAGES'
import json, sys
for ref, path in zip(sys.argv[2:4], sys.argv[4:6]):
    image = json.load(open(path))[0]
    env = dict(item.split('=', 1) for item in image['Config']['Env'] if '=' in item)
    if (ref not in image.get('RepoDigests', []) or
        image['Config'].get('Labels', {}).get('org.opencontainers.image.revision') != sys.argv[1] or
        env.get('APP_VERSION') != sys.argv[1]):
        raise SystemExit('Image digest, revision or APP_VERSION does not match approved deployment')
worker = json.load(open(sys.argv[5]))[0]['Config']
if (worker.get('Cmd') != ['node', '--import', 'tsx', 'workers/agent-worker/main.ts'] or
    worker.get('Entrypoint') not in (None, [], ['docker-entrypoint.sh'])):
    raise SystemExit('Approved worker image must run Node directly; live services preserved')
IMAGES

# The legacy pnpm wrapper kills its child after five seconds when PID 1 gets
# SIGTERM. Signal only the exact tsx Node child, leaving both wrappers to exit
# naturally. Resolve and recheck the full ancestry inside this container only.
cat > "$workdir/stop-legacy-worker.cjs" <<'LEGACY'
const fs = require('node:fs');
const path = require('node:path');
const worker = 'workers/agent-worker/main.ts';
function read(pid) {
  const root = '/proc/' + pid;
  const args = fs.readFileSync(root + '/cmdline', 'utf8').split('\0').filter(Boolean);
  const stat = fs.readFileSync(root + '/stat', 'utf8').split(') ').at(-1).split(' ');
  return { pid, args, parent: Number(stat[1]), start: stat[19], node: path.basename(fs.readlinkSync(root + '/exe')) === 'node' };
}
function target() {
  const root = read(1);
  if (!root.node || root.args.length !== 5 || path.basename(root.args[1]) !== 'pnpm' ||
      JSON.stringify(root.args.slice(2)) !== JSON.stringify(['exec', 'tsx', worker]))
    throw new Error('Legacy worker PID 1 is not the canonical pnpm command');
  const candidates = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^[1-9][0-9]*$/.test(entry)) continue;
    let child;
    try { child = read(Number(entry)); } catch { continue; }
    const a = child.args;
    if (!child.node || a.length !== 6 || a[1] !== '--require' ||
        !a[2].startsWith('/app/node_modules/') || !a[2].endsWith('/dist/preflight.cjs') ||
        a[3] !== '--import' || !a[4].startsWith('file:///app/node_modules/') ||
        !a[4].endsWith('/dist/loader.mjs') || a[5] !== worker) continue;
    const parent = read(child.parent);
    const cli = path.resolve(fs.readlinkSync('/proc/' + parent.pid + '/cwd'), parent.args[1] || '');
    if (!parent.node || parent.parent !== 1 || parent.args.length !== 3 ||
        !cli.startsWith('/app/node_modules/') ||
        !cli.endsWith('/tsx/dist/cli.mjs') || parent.args[2] !== worker) continue;
    candidates.push({ pid: child.pid, start: child.start, parent: parent.pid, parentStart: parent.start, rootStart: root.start });
  }
  if (candidates.length !== 1) throw new Error('Expected exactly one canonical legacy worker process');
  return candidates[0];
}
const found = target();
if (process.argv[2] === 'inspect') process.stdout.write(JSON.stringify(found));
else if (process.argv[2] === 'signal') {
  if (JSON.stringify(found) !== process.argv[3] || JSON.stringify(target()) !== process.argv[3])
    throw new Error('Legacy worker process changed before shutdown');
  process.kill(found.pid, 'SIGTERM');
} else throw new Error('Unsupported legacy shutdown operation');
LEGACY
legacy_target=''
if [[ "$worker_running" = true && "$worker_legacy" = true ]]; then
  legacy_target=$(docker exec -i "$worker_id" node - inspect < "$workdir/stop-legacy-worker.cjs")
fi

# COPY . . in Dockerfile.worker carries this exact, reviewed migration. Creating
# a container extracts the artifact without ever executing its CMD or loops.
extract_container=$(docker create "$worker_ref")
migration="$workdir/0415.sql"
docker cp "$extract_container:/app/supabase/migrations/20261001220000_0415_prospecting_inbox_scope.sql" "$migration"
native_migration="$workdir/0416.sql"
native_contract="$workdir/0416-contract.sql"
docker cp "$extract_container:/app/supabase/migrations/20261005160000_0416_meta_native_platform.sql" "$native_migration"
docker cp "$extract_container:/app/scripts/deploy-meta-native-contract.sql" "$native_contract"
privacy_migration="$workdir/0417.sql"
privacy_contract="$workdir/0417-contract.sql"
docker cp "$extract_container:/app/supabase/migrations/20261006193000_0417_meta_privacy_lifecycle.sql" "$privacy_migration"
docker cp "$extract_container:/app/scripts/deploy-meta-privacy-contract.sql" "$privacy_contract"
messaging_migration="$workdir/0418.sql"
messaging_contract="$workdir/0418-contract.sql"
docker cp "$extract_container:/app/supabase/migrations/20261006223000_0418_meta_social_messaging.sql" "$messaging_migration"
docker cp "$extract_container:/app/scripts/deploy-meta-messaging-contract.sql" "$messaging_contract"
# Extract the manifest and its exact inputs from the same immutable worker image.
# No directory scan and no assumption about historical Supabase migration state.
release_root="$workdir/release-source"
release_sql="$workdir/release-sql"
mkdir -p "$release_root/scripts" "$release_root/supabase/migrations"
for filename in build-upstream-release.py upstream-release.json upstream-release-preflight.sql upstream-release-postflight.sql; do
  docker cp "$extract_container:/app/scripts/$filename" "$release_root/scripts/$filename"
done
python3 - "$release_root/scripts/upstream-release.json" > "$workdir/release-files" <<'RELEASE_FILES'
import json, re, sys
entries = json.load(open(sys.argv[1]))['migrations']
if not entries:
    raise SystemExit('Release must contain explicit migrations')
for entry in entries:
    name = entry['file']
    if not re.fullmatch(r'20261016\d{6}_04[2-4]\d_[a-z0-9_]+\.sql', name):
        raise SystemExit('Migration outside the approved release range')
    print(name)
RELEASE_FILES
while IFS= read -r filename; do
  docker cp "$extract_container:/app/supabase/migrations/$filename" "$release_root/supabase/migrations/$filename"
done < "$workdir/release-files"
python3 "$release_root/scripts/build-upstream-release.py" "$release_root" "$release_sql"
docker rm "$extract_container" >/dev/null
extract_container=''
[[ -s "$migration" ]] || exit 1
grep -q '^-- 0415 ' "$migration"
grep -q '^create or replace function public.automatico_da_prospeccao' "$migration"
[[ -s "$native_migration" && -s "$native_contract" ]] || exit 1
grep -q '^create or replace function public.fn_meta_operation_checkpoint(' "$native_migration"
grep -q '^-- 0416 contract:' "$native_contract"
[[ -s "$privacy_migration" && -s "$privacy_contract" ]] || exit 1
grep -q '^create or replace function public.fn_meta_privacy_request(' "$privacy_migration"
grep -q '^-- 0417 contract:' "$privacy_contract"
[[ -s "$messaging_migration" && -s "$messaging_contract" ]] || exit 1
grep -q '^-- 0418 ' "$messaging_migration"
grep -q '^do \$meta_messaging_known_core\$$' "$messaging_migration"
grep -q '^create or replace function public.fn_meta_messaging_accept(' "$messaging_migration"
grep -q '^-- 0418 deploy gate\.' "$messaging_contract"

migration_state() {
  docker exec -i escreveai-db psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres <<'CONTRACT'
-- 0415 contract, including inherited PUBLIC/anon grants.
with target as (
  select to_regprocedure('public.automatico_da_prospeccao(public.conversations)')::oid as oid
)
select case
  when p.oid is null then 'missing'
  when p.prokind = 'f' and p.prorettype = 'pg_catalog.bool'::regtype
    and p.prosecdef and p.provolatile = 's'
    and coalesce(p.proconfig, '{}'::text[]) @> array['search_path=""']
    and has_function_privilege('authenticated', p.oid, 'execute')
    and has_function_privilege('service_role', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute')
    and not exists (
      select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) privilege
      where privilege.grantee = 0 and privilege.privilege_type = 'EXECUTE'
    ) then 'ready'
  else 'incompatible'
end
from target left join pg_proc p on p.oid = target.oid;
CONTRACT
}
schema_state=$(migration_state)
[[ "$schema_state" = missing || "$schema_state" = ready ]] || {
  echo 'Existing prospecting function has an incompatible contract; live services preserved' >&2
  exit 1
}
native_migration_state() {
  docker exec -i escreveai-db psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres < "$native_contract"
}
native_schema_state=$(native_migration_state)
[[ "$native_schema_state" = missing || "$native_schema_state" = ready ]] || {
  echo 'Native Meta schema is partial, incompatible or missing prerequisites; live services preserved' >&2
  exit 1
}
privacy_migration_state() {
  docker exec -i escreveai-db psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres < "$privacy_contract"
}
privacy_schema_state=$(privacy_migration_state)
[[ "$privacy_schema_state" = missing || "$privacy_schema_state" = ready ||
  ( "$privacy_schema_state" = dependencies_missing && "$native_schema_state" = missing ) ]] || {
  echo 'Meta privacy schema is partial, incompatible or missing prerequisites; live services preserved' >&2
  exit 1
}
messaging_migration_state() {
  docker exec -i escreveai-db psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres < "$messaging_contract"
}
messaging_schema_state=$(messaging_migration_state)
[[ "$messaging_schema_state" = missing || "$messaging_schema_state" = ready ||
  ( "$messaging_schema_state" = dependencies_missing &&
    ( "$native_schema_state" = missing || "$privacy_schema_state" = missing || "$privacy_schema_state" = dependencies_missing ) ) ]] || {
  echo 'Meta messaging schema is partial, incompatible or missing prerequisites; live services preserved' >&2
  exit 1
}

# Validate known old/new contracts before interrupting any service. The same
# checks run again inside the single transaction that applies this release.
release_state=$(docker exec -i escreveai-db psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres < "$release_sql/release-preflight.sql")
[[ "$release_state" = ready ]] || { echo 'Stable release preflight failed; live services preserved' >&2; exit 1; }
cp "$release_sql/release-apply.sql" "$backups/$stamp-stable-release.sql"

# All failures from this point, including a signal during stop/SQL/up/health,
# restore BOTH images and the worker's original running state.
rollback_needed=1
if [[ "$worker_running" = true ]]; then
  if [[ "$worker_legacy" = true ]]; then
    # An external signal does not mark a Docker container manually stopped.
    # Suppress auto-restart until Compose replaces it; finish restores on error.
    worker_restart_changed=1
    docker update --restart no "$worker_id" >/dev/null
    docker exec -i "$worker_id" node - signal "$legacy_target" < "$workdir/stop-legacy-worker.cjs"
    python3 - "$worker_id" "$worker_stop_seconds" <<'WAIT_LEGACY'
import subprocess, sys
try:
    result = subprocess.run(['docker', 'wait', sys.argv[1]], capture_output=True, text=True, timeout=int(sys.argv[2]))
except subprocess.TimeoutExpired:
    raise SystemExit('Legacy worker did not stop within its graceful deadline')
if result.returncode or result.stdout.strip() != '0':
    raise SystemExit('Legacy worker did not exit successfully')
WAIT_LEGACY
  else
    docker stop --time "$worker_stop_seconds" "$worker_id" >/dev/null
  fi
  docker inspect "$worker_id" | python3 -c 'import json,sys; state=json.load(sys.stdin)[0]["State"]; sys.exit(1 if state["Running"] or state.get("OOMKilled") or state.get("ExitCode") != 0 else 0)'
fi
# No migration ledger exists on this recovered installation. Apply only the
# additive function required by this release, never the entire baseline.
if [[ "$schema_state" = missing ]]; then
  # The first installation uses CREATE, so a concurrent manual installation
  # aborts rather than overwriting a newer function between our two checks.
  sed 's/^create or replace function public.automatico_da_prospeccao/create function public.automatico_da_prospeccao/' "$migration" > "$workdir/install-0415.sql"
  docker exec -i escreveai-db psql -X -1 -v ON_ERROR_STOP=1 -U postgres -d postgres < "$workdir/install-0415.sql"
fi
[[ "$(migration_state)" = ready ]] || exit 1
if [[ "$native_schema_state" = missing ]]; then
  # First installation must fail if an operator installs concurrently. Never
  # replace an existing function or adopt an unknown partial native schema.
  sed -e 's/^create or replace function public.fn_meta_/create function public.fn_meta_/' \
      -e 's/^create table if not exists public.meta_/create table public.meta_/' \
    "$native_migration" > "$workdir/install-0416.sql"
  docker exec -i escreveai-db psql -X -1 -v ON_ERROR_STOP=1 -U postgres -d postgres < "$workdir/install-0416.sql"
fi
[[ "$(native_migration_state)" = ready ]] || exit 1
if [[ "$privacy_schema_state" != ready ]]; then
  # 0416 may have supplied missing dependencies. Recheck before installing and
  # adopt no concurrent or partial privacy schema after the original preflight.
  [[ "$(privacy_migration_state)" = missing ]] || exit 1
  # Only NEW helpers become CREATE. The three existing core functions have a
  # migration-local allowlist of reviewed 0416 bodies before conditional upgrade.
  sed -e 's/^create or replace function public.fn_meta_privacy_/create function public.fn_meta_privacy_/' \
      -e 's/^create table if not exists public.meta_privacy_/create table public.meta_privacy_/' \
    "$privacy_migration" > "$workdir/install-0417.sql"
  docker exec -i escreveai-db psql -X -1 -v ON_ERROR_STOP=1 -U postgres -d postgres < "$workdir/install-0417.sql"
fi
[[ "$(privacy_migration_state)" = ready ]] || exit 1
if [[ "$messaging_schema_state" != ready ]]; then
  # Dependencies may have just been installed. Reject any concurrent adoption
  # or partial schema before touching the shared Inbox contracts.
  [[ "$(messaging_migration_state)" = missing ]] || exit 1
  # NEW helpers/columns/indexes must fail on a concurrent installation. The
  # existing event emitter is upgraded only by the migration's known-body gate.
  sed -e 's/^create or replace function public.fn_meta_messaging_/create function public.fn_meta_messaging_/' \
      -e 's/add column if not exists meta_social_/add column meta_social_/' \
      -e 's/^create unique index if not exists channel_sessions_meta_social_/create unique index channel_sessions_meta_social_/' \
    "$messaging_migration" > "$workdir/install-0418.sql"
  docker exec -i escreveai-db psql -X -1 -v ON_ERROR_STOP=1 -U postgres -d postgres < "$workdir/install-0418.sql"
fi
[[ "$(messaging_migration_state)" = ready ]] || exit 1
# All new schema changes and the private checksum journal commit together.
# A failure rolls this release back before the previous services are restored.
docker exec -i escreveai-db psql -X -qAt -1 -v ON_ERROR_STOP=1 -U postgres -d postgres < "$release_sql/release-apply.sql"
release_state=$(docker exec -i escreveai-db psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres < "$release_sql/release-verify.sql")
[[ "$release_state" = ready ]] || exit 1
docker exec escreveai-db psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -c "notify pgrst, 'reload schema';"
python3 - "$compose" "$tag" "$app_ref" "$worker_ref" <<'CONFIG'
import json, os, sys
path = sys.argv[1]
config = json.load(open(path))
for name, image in zip(('app', 'worker'), sys.argv[3:5]):
    config['services'][name]['image'] = image
    config['services'][name]['environment']['APP_VERSION'] = sys.argv[2]
if config['services']['worker'].get('command') == ['pnpm', 'exec', 'tsx', 'workers/agent-worker/main.ts']:
    config['services']['worker']['command'] = ['node', '--import', 'tsx', 'workers/agent-worker/main.ts']
    print('Migrated canonical legacy worker command to the approved Node command')
with open(path + '.tmp', 'w') as target:
    json.dump(config, target, indent=2)
    target.flush()
    os.fsync(target.fileno())
os.replace(path + '.tmp', path)
CONFIG

container_matches() {
  local id
  id=$(service_id "$1")
  [[ -n "$id" ]] || return 1
  docker inspect "$id" > "$workdir/container.json"
  python3 - "$workdir/container.json" "$workdir/$1-image.json" "$tag" "$1" <<'CONTAINER'
import json, sys
container = json.load(open(sys.argv[1]))[0]
image = json.load(open(sys.argv[2]))[0]
env = dict(item.split('=', 1) for item in container['Config']['Env'] if '=' in item)
state = container['State']
valid = (state['Running'] and not state.get('Paused') and
         container['Image'] == image['Id'] and
         container['Config'].get('Labels', {}).get('org.opencontainers.image.revision') == sys.argv[3] and
         env.get('APP_VERSION') == sys.argv[3])
if sys.argv[4] == 'app':
    valid = valid and state.get('Health', {}).get('Status') == 'healthy'
else:
    valid = valid and container['Config'].get('Cmd') == ['node', '--import', 'tsx', 'workers/agent-worker/main.ts']
sys.exit(0 if valid else 1)
CONTAINER
}
app_healthy() {
  container_matches app || return 1
  curl --fail --silent --show-error --max-time 10 --resolve os.escreve.ai:443:127.0.0.1 https://os.escreve.ai/api/v1/health > "$workdir/health.json" || return 1
  python3 - "$workdir/health.json" "$tag" <<'HEALTH' || return 1
import json, sys
health = json.load(open(sys.argv[1]))['data']
sys.exit(0 if health['status'] == 'healthy' and health['version'] == sys.argv[2] else 1)
HEALTH
  curl --fail --silent --show-error --max-time 10 --resolve os.escreve.ai:443:127.0.0.1 https://os.escreve.ai/login >/dev/null
}
worker_healthy() {
  container_matches worker || return 1
  local id
  id=$(service_id worker)
  docker exec "$id" node -e '
    fetch("http://127.0.0.1:" + (process.env.HEALTH_PORT || "8787") + "/healthz", {signal: AbortSignal.timeout(5000)})
      .then(async response => { const health = await response.json(); if (!response.ok || health.status !== "ok" || health.db !== "ok" || health.event_log_drain?.carregado !== true) process.exit(1); })
      .catch(() => process.exit(1));'
}
wait_for() {
  local attempt
  for attempt in {1..40}; do
    if "$1"; then return 0; fi
    sleep 3
  done
  return 1
}
docker compose -f "$compose" up -d --no-deps app
wait_for app_healthy
if [[ "$worker_running" = true ]]; then
  docker compose -f "$compose" up -d --no-deps worker
  wait_for worker_healthy
else
  service_running worker false
fi
rollback_needed=0
echo "Deployed app and worker configuration at $tag (worker previously running: $worker_running)"
