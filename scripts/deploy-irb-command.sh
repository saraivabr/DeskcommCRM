#!/usr/bin/env bash
# Forced SSH command: installed root-owned at /usr/local/sbin/escreveai-deploy-ssh.
set -euo pipefail
command=${SSH_ORIGINAL_COMMAND:-}
if [[ "$command" =~ ^([a-f0-9]{40})\ (sha256:[a-f0-9]{64})\ (sha256:[a-f0-9]{64})$ ]]; then
  exec sudo -n /opt/escreveai/deploy-live.sh "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
fi
echo 'Invalid immutable deployment command' >&2
exit 2
