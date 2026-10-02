#!/usr/bin/env bash
# Local deploy harness (phase 12): runs the REAL server scripts of deploy/bin against a local
# Docker (Linux, or Windows with Git Bash + Docker Desktop), with images built locally — before
# a release, and to reproduce a server problem. Nothing reaches a registry or the internet
# except the pinned tool images. Isolated: project "smartops-m0test" (HARNESS_PROJECT), ports on 127.0.0.1 only,
# its own state under <workdir>. Needs images tagged <prefix>/smartops-{api,admin}:<a> and :<b>:
#
#   docker build -f apps/api/Dockerfile   -t smartops-local/smartops-api:m0a .
#   docker build -f apps/admin/Dockerfile -t smartops-local/smartops-admin:m0a .
#   docker tag smartops-local/smartops-api:m0a smartops-local/smartops-api:m0b   (same for admin)
#   scripts/deploy/local-harness.sh <empty workdir>
#
# Steps: fetch bundle a → init-secrets (+ idempotency) → deploy a → smoke through Caddy (headers,
# blocked routes, SSE, a sample through n8n) → backup → deploy b (pre-deploy backup) → restore
# test of that backup with a throw-away key → rollback to a → a fake newer migration makes the
# rollback refuse until --accept-newer-schema. Teardown is printed, not run (your decision).
set -euo pipefail
export MSYS_NO_PATHCONV=1
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

work="${1:?usage: local-harness.sh <empty workdir>}"
mkdir -p "$work"
work="$(native "$(cd "$work" && pwd)")"
repo="$(native "$(cd "$(dirname "$0")/../.." && pwd)")"
A="${HARNESS_VERSION_A:-m0a}"
B="${HARNESS_VERSION_B:-m0b}"
# HARNESS_PROFILE=light tests the 1 GB profile (ADR-025: no n8n); HARNESS_PROJECT isolates a run.
PROFILE="${HARNESS_PROFILE:-full}"
PROJECT="${HARNESS_PROJECT:-smartops-m0test}"
export SMARTOPS_LOCAL=1 SMARTOPS_HOME="$work/opt" SMARTOPS_ETC="$work/etc" \
  SMARTOPS_PROJECT="$PROJECT" SMARTOPS_IMAGE_PREFIX="${HARNESS_IMAGE_PREFIX:-smartops-local}" \
  CADDY_BIND_ADDRESS=127.0.0.1
step() { printf '\n══ %s\n' "$*"; }
bin() { printf '%s/opt/releases/%s/bin' "$work" "$1"; }

step "bundle $A + secrets"
bash "$repo/deploy/bin/fetch-bundle.sh" "$A"
bash "$(bin "$A")/init-secrets.sh" --domain localhost --profile "$PROFILE"
before="$(sha256sum "$work/etc/demo.env")"
bash "$(bin "$A")/init-secrets.sh" --domain localhost --profile "$PROFILE"
[ "$before" = "$(sha256sum "$work/etc/demo.env")" ] || {
  echo "init-secrets is not idempotent" >&2
  exit 1
}

step "throw-away age key (the owner's real key never exists here)"
mkdir -p "$work/pc-key"
docker run --rm -v "$work/pc-key:/k" \
  alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 \
  sh -c 'apk add -q --no-cache age >/dev/null && [ -f /k/key.txt ] || age-keygen -o /k/key.txt 2>/dev/null'
printf 'BACKUP_AGE_RECIPIENT=%s\nBACKUP_TARGET=dir\nBACKUP_DIR_TARGET=%s\n' \
  "$(grep -o 'age1[0-9a-z]*' "$work/pc-key/key.txt")" "$work/bucket" >"$work/etc/backup.env"

step "deploy $A (first install)"
time bash "$(bin "$A")/deploy.sh" "$A"

step "smoke through Caddy"
node "$repo/scripts/deploy/local-smoke.mjs"

step "deploy $B (with the pre-deploy backup)"
time bash "$(bin "$A")/deploy.sh" "$B"
latest="$(find "$work/bucket" -mindepth 1 -maxdepth 1 -type d -name "*pre-deploy-$B" | sort | tail -n 1)"
[ -n "$latest" ] || {
  echo "no pre-deploy backup found" >&2
  exit 1
}

step "restore test of $(basename "$latest") (owner's PC path)"
bash "$repo/deploy/bin/restore-test.sh" --dir "$latest" --identity "$work/pc-key/key.txt"

step "rollback to $A"
bash "$(bin "$B")/rollback.sh"
[ "$(cat "$work/opt/state/current")" = "$A" ] || {
  echo "rollback did not switch to $A" >&2
  exit 1
}

step "a newer schema makes the rollback refuse (expand/contract confirmation)"
docker compose -p "$PROJECT" exec -T postgres psql -U postgres -d smartops_demo -qc \
  "INSERT INTO _prisma_migrations (id, checksum, migration_name, finished_at, applied_steps_count) VALUES ('harness', 'x', '29991231000000_harness_future', now(), 1)"
if bash "$(bin "$A")/rollback.sh" "$B" 2>/dev/null; then
  echo "rollback should have refused" >&2
  exit 1
fi
bash "$(bin "$A")/rollback.sh" "$B" --accept-newer-schema
docker compose -p "$PROJECT" exec -T postgres psql -U postgres -d smartops_demo -qc \
  "DELETE FROM _prisma_migrations WHERE id = 'harness'"

step "HARNESS PASSED — teardown when you are done (it deletes this test stack's data):"
echo "  docker compose -p $PROJECT down"
echo "  docker volume rm ${PROJECT}_postgres_data ${PROJECT}_n8n_data ${PROJECT}_caddy_data ${PROJECT}_caddy_config"
