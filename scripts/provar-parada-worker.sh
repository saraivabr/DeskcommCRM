#!/usr/bin/env bash
# Usa o CMD/ENTRYPOINT da imagem, sem rede, com uma sonda sobre o main.
set -euo pipefail
[[ $# -eq 1 && -n "$1" && "$1" != -* ]] || { echo 'Expected worker image' >&2; exit 2; }
probe_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
probe_name="worker-stop-probe-$$"
probe_logs=$(mktemp)
cleanup() {
  local status=$?
  trap - EXIT
  if [[ "$status" != 0 ]]; then docker logs "$probe_name" 2>&1 || true; fi
  docker rm -f "$probe_name" >/dev/null 2>&1 || true
  rm -f "$probe_logs"
  exit "$status"
}
trap cleanup EXIT
docker run -d --pull never --name "$probe_name" --network none \
  --mount "type=bind,source=$probe_root/scripts/fixtures/worker-shutdown.ts,target=/app/workers/agent-worker/main.ts,readonly" \
  "$1" >/dev/null
# Até 15s para carregar o TS; a parada abaixo tem teto próprio de 12s.
probe_deadline=$((SECONDS + 15))
while (( SECONDS < probe_deadline )); do
  docker logs "$probe_name" > "$probe_logs" 2>&1
  grep -Fxq 'worker-stop-probe: ready' "$probe_logs" && break
  [[ "$(docker inspect --format '{{.State.Running}}' "$probe_name")" = true ]] || break
  sleep 0.1
done
grep -Fxq 'worker-stop-probe: ready' "$probe_logs"
docker stop --time 12 "$probe_name" >/dev/null
[[ "$(docker inspect --format '{{.State.Running}} {{.State.OOMKilled}} {{.State.ExitCode}}' "$probe_name")" = 'false false 0' ]]
docker logs "$probe_name" > "$probe_logs" 2>&1
grep -Fxq 'worker-stop-probe: stopping' "$probe_logs"
grep -Fxq 'worker-stop-probe: drained' "$probe_logs"
grep -Fxq 'worker-stop-probe: telemetry-close' "$probe_logs"
echo 'Worker CMD aguardou trabalho por mais de 5s e encerrou 0 apesar do handle residual.'
