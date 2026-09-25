#!/usr/bin/env bash
# Installed root-owned at /opt/escreveai/deploy-live.sh on the production host.
set -euo pipefail
tag="${1:-}"
[[ "$tag" =~ ^[a-f0-9]{7,40}$ ]] || { echo 'Invalid image tag'; exit 2; }
root=/opt/escreveai
exec 9>/run/lock/escreveai-deploy.lock
flock -n 9 || { echo 'Deployment already running'; exit 1; }
stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p /opt/backups/escreveai
chmod 700 /opt/backups/escreveai
umask 077
docker exec escreveai-db pg_dump -U postgres -d postgres -Fc > "/opt/backups/escreveai/$stamp.dump.tmp"
mv "/opt/backups/escreveai/$stamp.dump.tmp" "/opt/backups/escreveai/$stamp.dump"
docker pull "ghcr.io/saraivabr/deskcomm-app:$tag"
cp "$root/compose.json" "$root/compose.before-$stamp.json"
python3 - "$tag" <<'PY'
import json, os, sys
path = '/opt/escreveai/compose.json'
with open(path) as source:
    config = json.load(source)
config['services']['app']['image'] = 'ghcr.io/saraivabr/deskcomm-app:' + sys.argv[1]
config['services']['app']['environment']['APP_VERSION'] = sys.argv[1]
with open(path + '.tmp', 'w') as target:
    json.dump(config, target, indent=2)
os.replace(path + '.tmp', path)
PY
if docker compose -f "$root/compose.json" up -d --no-deps app; then
  for attempt in {1..40}; do
    if [ "$(docker inspect escreveai-app --format '{{.State.Health.Status}}')" = healthy ] &&
      curl --fail --silent --max-time 10 --resolve os.escreve.ai:443:127.0.0.1 https://os.escreve.ai/login >/dev/null; then
      echo "Deployed $tag"
      exit 0
    fi
    sleep 3
  done
fi
echo 'Deployment failed; restoring previous application image' >&2
cp "$root/compose.before-$stamp.json" "$root/compose.json"
docker compose -f "$root/compose.json" up -d --no-deps app
exit 1
