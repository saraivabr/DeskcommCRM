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
    docker compose -f "$compose" up -d --no-deps app || restored=1
    if [[ "$worker_running" = true ]]; then
      docker compose -f "$compose" up -d --no-deps worker || restored=1
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
if not app['State']['Running'] or app['State'].get('Paused') or worker['State'].get('Paused'):
    raise SystemExit('Unexpected app or paused worker state; live configuration preserved')
env = dict(item.split('=', 1) for item in worker['Config']['Env'] if '=' in item)
grace = int(env.get('SHUTDOWN_GRACE_MS', '30000'))
if not 0 < grace <= 300000:
    raise SystemExit('Unsupported worker graceful shutdown timeout')
print(str(worker['State']['Running']).lower(), math.ceil(grace / 1000) + 30)
STATE
read -r worker_running worker_stop_seconds < "$workdir/previous-state"
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
IMAGES

# COPY . . in Dockerfile.worker carries this exact, reviewed migration. Creating
# a container extracts the artifact without ever executing its CMD or loops.
extract_container=$(docker create "$worker_ref")
migration="$workdir/0415.sql"
docker cp "$extract_container:/app/supabase/migrations/20261001220000_0415_prospecting_inbox_scope.sql" "$migration"
native_migration="$workdir/0416.sql"
native_contract="$workdir/0416-contract.sql"
docker cp "$extract_container:/app/supabase/migrations/20261005160000_0416_meta_native_platform.sql" "$native_migration"
docker cp "$extract_container:/app/scripts/deploy-meta-native-contract.sql" "$native_contract"
docker rm "$extract_container" >/dev/null
extract_container=''
[[ -s "$migration" ]]
grep -q '^-- 0415 ' "$migration"
grep -q '^create or replace function public.automatico_da_prospeccao' "$migration"
[[ -s "$native_migration" && -s "$native_contract" ]]
grep -q '^create or replace function public.fn_meta_operation_checkpoint(' "$native_migration"
grep -q '^-- 0416 contract:' "$native_contract"

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

# All failures from this point, including a signal during stop/SQL/up/health,
# restore BOTH images and the worker's original running state.
rollback_needed=1
if [[ "$worker_running" = true ]]; then
  docker stop --time "$worker_stop_seconds" "$worker_id" >/dev/null
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
[[ "$(migration_state)" = ready ]]
if [[ "$native_schema_state" = missing ]]; then
  # First installation must fail if an operator installs concurrently. Never
  # replace an existing function or adopt an unknown partial native schema.
  sed -e 's/^create or replace function public.fn_meta_/create function public.fn_meta_/' \
      -e 's/^create table if not exists public.meta_/create table public.meta_/' \
    "$native_migration" > "$workdir/install-0416.sql"
  docker exec -i escreveai-db psql -X -1 -v ON_ERROR_STOP=1 -U postgres -d postgres < "$workdir/install-0416.sql"
fi
[[ "$(native_migration_state)" = ready ]]
docker exec escreveai-db psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -c "notify pgrst, 'reload schema';"
python3 - "$compose" "$tag" "$app_ref" "$worker_ref" <<'CONFIG'
import json, os, sys
path = sys.argv[1]
config = json.load(open(path))
for name, image in zip(('app', 'worker'), sys.argv[3:5]):
    config['services'][name]['image'] = image
    config['services'][name]['environment']['APP_VERSION'] = sys.argv[2]
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
