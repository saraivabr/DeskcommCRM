#!/usr/bin/env bash
# Smoke do CI em checkout descartável: banco/Auth reais e Next de produção.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${CI:-}" != "true" ]]; then
  echo 'ERRO: smoke aceita somente CI=true em checkout descartável.' >&2
  exit 1
fi
for file in .env .env.local .env.production .env.production.local .env.e2e; do
  if [[ -e "$file" ]]; then
    echo "ERRO: checkout contém $file; smoke exige ambiente limpo e não o sobrescreve." >&2
    exit 1
  fi
done
for command in supabase psql pnpm node docker; do
  command -v "$command" >/dev/null || { echo "ERRO: falta $command" >&2; exit 1; }
done
if supabase status >/dev/null 2>&1; then
  echo 'ERRO: já existe stack Supabase neste checkout; recusado para preservar seus dados.' >&2
  exit 1
fi

smoke_tmp="$(mktemp -d)"
smoke_started=false
smoke_network="ci-smoke-$$"
cleanup() {
  local result=$?
  if [[ -d "$smoke_tmp/migrations" ]]; then
    rmdir supabase/migrations
    mv "$smoke_tmp/migrations" supabase/migrations
  fi
  if [[ "$smoke_started" == true ]]; then
    supabase stop --no-backup >/dev/null 2>&1 || true
  fi
  docker rm -f "$smoke_network-redis-http" "$smoke_network-redis" >/dev/null 2>&1 || true
  docker network rm "$smoke_network" >/dev/null 2>&1 || true
  rm -rf "$smoke_tmp"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# A cadeia histórica não representa instalação fresh; produto usa baseline.sql.
mv supabase/migrations "$smoke_tmp/migrations"
mkdir supabase/migrations
smoke_started=true
supabase start -x studio,postgres-meta
rmdir supabase/migrations
mv "$smoke_tmp/migrations" supabase/migrations

export E2E_PORT=3001
pnpm e2e:env
# Gerado pelo CLI local acima; não aceita arquivo preexistente nem credenciais remotas.
set -a
# shellcheck disable=SC1091
source .env.e2e
set +a
node <<'JS'
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_DB_URL']) {
  const url = new URL(process.env[key]);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error(`Smoke recusou host não local em ${key}`);
  }
}
JS
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
create schema if not exists extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema public;
create extension if not exists citext with schema public;
create extension if not exists pg_trgm with schema public;
SQL
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -q -f supabase/baseline.sql
# PostgREST precisa reler tabelas adicionadas antes do bootstrap via REST.
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -q -c "NOTIFY pgrst, 'reload schema';"

# Redis real para o rate limiter; lib/env exige estas variáveis no build de produção.
docker network create "$smoke_network" >/dev/null
docker run -d --name "$smoke_network-redis" --network "$smoke_network" --network-alias redis redis:7-alpine >/dev/null
for attempt in {1..20}; do
  if docker exec "$smoke_network-redis" redis-cli ping | grep -q PONG; then break; fi
  sleep 1
done
docker exec "$smoke_network-redis" redis-cli ping | grep -q PONG
docker run -d --name "$smoke_network-redis-http" --network "$smoke_network" -p 127.0.0.1:3998:80 \
  -e SRH_MODE=env -e SRH_TOKEN="$UPSTASH_REDIS_REST_TOKEN" -e SRH_CONNECTION_STRING=redis://redis:6379 \
  hiett/serverless-redis-http@sha256:5b0bb9239fce53abf87b2018a7a0deb9ec7bd900c5360738fe5fbeeb426f9150 >/dev/null
node <<'JS'
(async () => {
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/organizations?select=id&limit=1`, {
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` },
    }).catch(() => null);
    const redis = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/ping`, {
      headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
    }).catch(() => null);
    if (response?.ok && redis?.ok) return;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('PostgREST/Redis não ficaram prontos para o smoke');
})();
JS
unset OPENAI_API_KEY ANTHROPIC_API_KEY GOOGLE_GENERATIVE_AI_API_KEY AI_GATEWAY_API_KEY
export BILLING_ENABLED=false
export SENTRY_DSN=off
pnpm exec tsx scripts/bootstrap-owner.ts
# Fixture explícita: este smoke mede sessão e telas pós-onboarding, não o wizard.
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -q -v owner_email="$OWNER_EMAIL" <<'SQL'
update organizations set onboarded_at=now()
where created_by=(select id from auth.users where email=:'owner_email');
SQL
pnpm e2e:build
pnpm exec playwright test --config playwright.ci-smoke.config.ts
