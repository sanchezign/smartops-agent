#!/usr/bin/env bash
# Deploy bundle checks (phase 12), run by the quick CI job and locally:
#   - shellcheck on every server / CI script
#   - `caddy validate` + `caddy fmt` on deploy/Caddyfile
#   - `docker compose config` on deploy/compose.yaml (full) and deploy/compose.light.yaml (the
#     1 GB profile, ADR-025) with FAKE values, then their invariants
#     (scripts/ci/check-deploy-compose.mjs)
# Tool images pinned by digest (Renovate keeps them current).
set -euo pipefail
export MSYS_NO_PATHCONV=1
# Native paths for docker / node: on Windows (Git Bash) C:/… instead of /c/…; unchanged on Linux.
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
root="$(native "$(cd "$(dirname "$0")/../.." && pwd)")"
mount="$root"

echo "== shellcheck"
docker run --rm -v "$mount:/mnt:ro" -w /mnt \
  koalaman/shellcheck:v0.11.0@sha256:61862eba1fcf09a484ebcc6feea46f1782532571a34ed51fedf90dd25f925a8d \
  -x -P deploy/bin deploy/bin/*.sh deploy/postgres-init/*.sh scripts/ci/*.sh scripts/deploy/*.sh \
  scripts/git-hooks/pre-push

echo "== Caddyfile"
docker run --rm -v "$mount/deploy:/c:ro" -e DEMO_DOMAIN=demo.example.duckdns.org \
  caddy:2.11.4-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b \
  sh -c 'caddy validate --config /c/Caddyfile --adapter caddyfile >/dev/null 2>&1 || caddy validate --config /c/Caddyfile --adapter caddyfile
         caddy fmt /c/Caddyfile | diff -u /c/Caddyfile - && echo "Caddyfile valid and formatted"'

echo "== compose.yaml and compose.light.yaml"
env_file="$(native "$(mktemp)")"
trap 'rm -f "$env_file"' EXIT
for key in POSTGRES_SUPERUSER_PASSWORD POSTGRES_APP_PASSWORD N8N_DB_PASSWORD N8N_ENCRYPTION_KEY \
  INTERNAL_API_KEY JWT_ACCESS_SECRET N8N_WEBHOOK_SECRET DEMO_FAKE_WHATSAPP_TOKEN \
  DEMO_FAKE_WHATSAPP_APP_SECRET DEMO_FAKE_WHATSAPP_VERIFY_TOKEN; do
  echo "$key=ci-fake-value-0123456789abcdef0123456789abcdef" >>"$env_file"
done
echo "DEMO_DOMAIN=demo.example.duckdns.org" >>"$env_file"
SMARTOPS_VERSION=0.0.0 docker compose -f "$root/deploy/compose.yaml" --env-file "$env_file" \
  --profile tools config --format json | node "$root/scripts/ci/check-deploy-compose.mjs" full
SMARTOPS_VERSION=0.0.0 docker compose -f "$root/deploy/compose.light.yaml" --env-file "$env_file" \
  --profile tools config --format json | node "$root/scripts/ci/check-deploy-compose.mjs" light
