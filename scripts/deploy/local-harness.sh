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

step "backup through the OCI CLI path (a FAKE CLI image: exact arguments, readable files, append-only flags)"
fake="$work/fake-oci-ctx"
rec="$work/oci-rec"
mkdir -p "$fake" "$rec"
cat >"$fake/fake-oci" <<'FAKE'
#!/bin/sh
# Records what backup.sh asks the OCI CLI to do and proves this container can READ the file it is given.
echo "uid=$(id -u) args: $*" >>/rec/calls.log
case " $* " in *" --force "*) echo "FORBIDDEN --force" >>/rec/errors.log ;; esac
for need in "--auth instance_principal" "--namespace-name fakens" "--bucket-name smartops-backups" "--no-multipart" "--no-overwrite"; do
  case "$*" in *"$need"*) ;; *) echo "MISSING $need" >>/rec/errors.log ;; esac
done
file=""
name=""
while [ $# -gt 0 ]; do
  case "$1" in --file) file=$2; shift ;; --name) name=$2; shift ;; esac
  shift
done
[ -r "$file" ] || { echo "UNREADABLE $file" >>/rec/errors.log; exit 1; }
mkdir -p "/rec/up/$(dirname "$name")"
cp "$file" "/rec/up/$name"
FAKE
docker build -q -t smartops-local/fake-oci-cli:harness -f - "$fake" >/dev/null <<'DOCKERFILE'
FROM alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6
COPY fake-oci /fake-oci
RUN chmod 755 /fake-oci
ENTRYPOINT ["/fake-oci"]
DOCKERFILE
printf 'BACKUP_AGE_RECIPIENT=%s\nBACKUP_TARGET=oci\nOCI_BUCKET=smartops-backups\nOCI_NAMESPACE=fakens\n' \
  "$(grep -o 'age1[0-9a-z]*' "$work/pc-key/key.txt")" >"$work/etc/backup-oci.env"
BACKUP_ENV="$work/etc/backup-oci.env" SMARTOPS_OCI_CLI_IMAGE=smartops-local/fake-oci-cli:harness \
  SMARTOPS_OCI_DOCKER_ARGS="-v $rec:/rec" bash "$(bin "$A")/backup.sh" --reason oci-fake --version "$A"
[ ! -s "$rec/errors.log" ] || {
  echo "the OCI upload path is wrong:" >&2
  cat "$rec/errors.log" >&2
  exit 1
}
uploaded="$(find "$rec/up" -type f | sort)"
while read -r line; do echo "  uploaded: ${line#*/up/}"; done <<<"$uploaded"
for expected in smartops_demo.dump.age demo.env.age manifest.txt; do
  echo "$uploaded" | grep -q "oci-fake/$expected$" || {
    echo "missing upload: $expected" >&2
    exit 1
  }
done
grep -q '^uid=0 ' "$rec/calls.log" || {
  echo "the CLI container must run as root with no capabilities (files are root's, mode 600)" >&2
  exit 1
}
echo "ok   OCI path: $(wc -l <"$rec/calls.log") uploads, readable as the container user, --no-overwrite, no --force, namespace given"

step "deploy $B (with the pre-deploy backup)"
time bash "$(bin "$A")/deploy.sh" "$B"
latest="$(find "$work/bucket" -mindepth 1 -maxdepth 1 -type d -name "*pre-deploy-$B" | sort | tail -n 1)"
[ -n "$latest" ] || {
  echo "no pre-deploy backup found" >&2
  exit 1
}

step "restore test of $(basename "$latest") (owner's PC path)"
bash "$repo/deploy/bin/restore-test.sh" --dir "$latest" --identity "$work/pc-key/key.txt"

step "restore test again with the names a browser download gives (<folder>_<name>)"
prefixed="$work/browser-download"
mkdir -p "$prefixed"
for f in "$latest"/*; do cp "$f" "$prefixed/$(basename "$latest")_$(basename "$f")"; done
bash "$repo/deploy/bin/restore-test.sh" --dir "$prefixed" --identity "$work/pc-key/key.txt"

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
