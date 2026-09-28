#!/usr/bin/env bash
# Restore test — runs on the OWNER'S PC, never on the server (phase 12, user addendum B): the
# age private key stays on this PC. It decrypts one backup, restores both databases into a
# THROW-AWAY Postgres container and checks that the data is really there. Nothing touches the
# server or the real demo. Needs Docker; age is used from PATH, or from a small container.
#
#   deploy/bin/restore-test.sh --dir <downloaded backup folder> --identity <age key file> \
#     [--hc-url https://hc-ping.com/<uuid>]
#
# <downloaded backup folder> = one "<UTC>-<reason>/" folder from the bucket (Object Storage →
# bucket → objects → download, or `oci os object bulk-download` with YOUR OCI CLI).
# --hc-url: the monthly "restore tested" Healthchecks.io check — it only emails you when a
# month goes by without a successful restore test (the reminder, not a server timer).
set -euo pipefail
export MSYS_NO_PATHCONV=1

dir=""
identity=""
hc=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dir)
      dir="${2:-}"
      shift 2
      ;;
    --identity)
      identity="${2:-}"
      shift 2
      ;;
    --hc-url)
      hc="${2:-}"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done
[ -d "$dir" ] && [ -f "$identity" ] || {
  echo "usage: restore-test.sh --dir <backup folder> --identity <age key file> [--hc-url <url>]" >&2
  exit 2
}
# Absolute path Docker can mount: on Windows (Git Bash) `pwd -W` gives C:/…, not /c/….
abs_dir() { (cd "$1" && { pwd -W 2>/dev/null || pwd; }); }
dir="$(abs_dir "$dir")"
identity_dir="$(abs_dir "$(dirname "$identity")")"
identity_file="$(basename "$identity")"

PG_IMAGE="postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24"
AGE_IMAGE="alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6"
name="smartops-restore-test-$$"

log() { printf '%s  %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; }
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

decrypt() { # $1 = file name inside $dir → plaintext on stdout (never written to disk)
  if command -v age >/dev/null 2>&1; then
    age -d -i "$identity_dir/$identity_file" "$dir/$1"
  else
    docker run --rm -v "$dir:/b:ro" -v "$identity_dir:/k:ro" "$AGE_IMAGE" \
      sh -c "apk add -q --no-cache age >/dev/null && age -d -i '/k/$identity_file' '/b/$1'"
  fi
}

[ -f "$dir/manifest.txt" ] && sed 's/^/    /' "$dir/manifest.txt" >&2
if command -v sha256sum >/dev/null 2>&1 && [ -f "$dir/manifest.txt" ]; then
  (cd "$dir" && grep -E '^[0-9a-f]{64} [ *]' manifest.txt | sha256sum -c --quiet -) || {
    log "checksums do not match the manifest"
    exit 1
  }
  log "checksums OK"
fi

log "starting a throw-away Postgres ($name)"
docker run -d --name "$name" -e POSTGRES_PASSWORD=restore-test-only "$PG_IMAGE" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$name" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
sleep 2
psql_q() { docker exec -i "$name" psql -U postgres -v ON_ERROR_STOP=1 -Atq "$@"; }

for db in smartops_demo n8n; do
  [ -f "$dir/$db.dump.age" ] || {
    log "missing $db.dump.age"
    exit 1
  }
  log "restoring $db"
  psql_q -c "CREATE DATABASE $db"
  decrypt "$db.dump.age" | docker exec -i "$name" pg_restore -U postgres --no-owner -d "$db" --exit-on-error
done

count() { psql_q -d "$1" -c "SELECT count(*) FROM $2"; }
migrations="$(count smartops_demo _prisma_migrations)"
users="$(count smartops_demo users)"
products="$(count smartops_demo products)"
messages="$(count smartops_demo messages)"
workflows="$(count n8n workflow_entity)"
credentials="$(count n8n credentials_entity)"
printf '    migrations=%s users=%s products=%s messages=%s n8n_workflows=%s n8n_credentials=%s\n' \
  "$migrations" "$users" "$products" "$messages" "$workflows" "$credentials" >&2

ok=1
[ "$migrations" -gt 0 ] || ok=0
[ "$users" -gt 0 ] || ok=0
[ "$products" -gt 0 ] || ok=0
[ "$workflows" -ge 4 ] || ok=0
[ "$credentials" -ge 2 ] || ok=0
# The secrets file decrypts too (without it n8n's credentials cannot be read).
decrypt demo.env.age | grep -qE '^N8N_ENCRYPTION_KEY=.{32,}' || {
  log "demo.env.age does not decrypt to a secrets file with N8N_ENCRYPTION_KEY"
  ok=0
}

if [ "$ok" -ne 1 ]; then
  log "RESTORE TEST FAILED"
  [ -n "$hc" ] && curl -fsS -m 10 -o /dev/null "$hc/fail" || true
  exit 1
fi
log "RESTORE TEST PASSED — the throw-away database is removed now"
[ -n "$hc" ] && curl -fsS -m 10 -o /dev/null "$hc" || true
