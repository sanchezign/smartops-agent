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
# bucket → objects → download, or `oci os object bulk-download` with YOUR OCI CLI). A browser
# download names each file "<folder>_<name>" (e.g. 20261003T203033Z-manual_demo.env.age): that is
# accepted as it is, no renaming needed.
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

# The files of a backup by their canonical name; the Console download prefixes them with the folder
# ("<folder>_<name>"), so accept exactly one file ending in "_<name>" / "-<name>" too.
file_of() {
  local n="$1" candidates
  if [ -f "$dir/$n" ]; then
    echo "$n"
    return 0
  fi
  candidates=("$dir"/*[_-]"$n")
  if [ "${#candidates[@]}" -eq 1 ] && [ -f "${candidates[0]}" ]; then
    basename "${candidates[0]}"
    return 0
  fi
  return 1
}

decrypt() { # $1 = canonical file name of the backup → plaintext on stdout (never written to disk)
  local actual
  actual="$(file_of "$1")" || {
    log "missing $1 in $dir"
    return 1
  }
  set -- "$actual"
  if command -v age >/dev/null 2>&1; then
    age -d -i "$identity_dir/$identity_file" "$dir/$1"
  else
    docker run --rm -v "$dir:/b:ro" -v "$identity_dir:/k:ro" "$AGE_IMAGE" \
      sh -c "apk add -q --no-cache age >/dev/null && age -d -i '/k/$identity_file' '/b/$1'"
  fi
}

manifest="$(file_of manifest.txt)" || manifest=""
[ -n "$manifest" ] && sed 's/^/    /' "$dir/$manifest" >&2
if command -v sha256sum >/dev/null 2>&1 && [ -n "$manifest" ]; then
  # The manifest names the files as the server wrote them; they may carry the download prefix here.
  checks="$(mktemp)"
  while read -r hash path; do
    path="${path#\*}"
    actual="$(file_of "${path#./}")" || {
      log "the manifest lists ${path#./} but it is not in $dir"
      exit 1
    }
    printf '%s  %s\n' "$hash" "$actual" >>"$checks"
  done < <(grep -E '^[0-9a-f]{64} [ *]' "$dir/$manifest")
  (cd "$dir" && sha256sum -c --quiet "$checks") || {
    log "checksums do not match the manifest"
    rm -f "$checks"
    exit 1
  }
  rm -f "$checks"
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

# The light profile (ADR-025) has no n8n database: its backups carry only smartops_demo.
has_n8n=0
file_of n8n.dump.age >/dev/null && has_n8n=1
databases=(smartops_demo)
[ "$has_n8n" -eq 1 ] && databases+=(n8n)
for db in "${databases[@]}"; do
  file_of "$db.dump.age" >/dev/null || {
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
printf '    migrations=%s users=%s products=%s messages=%s\n' \
  "$migrations" "$users" "$products" "$messages" >&2
if [ "$has_n8n" -eq 1 ]; then
  workflows="$(count n8n workflow_entity)"
  credentials="$(count n8n credentials_entity)"
  printf '    n8n_workflows=%s n8n_credentials=%s\n' "$workflows" "$credentials" >&2
fi

ok=1
[ "$migrations" -gt 0 ] || ok=0
[ "$users" -gt 0 ] || ok=0
[ "$products" -gt 0 ] || ok=0
if [ "$has_n8n" -eq 1 ]; then
  [ "$workflows" -ge 4 ] || ok=0
  [ "$credentials" -ge 2 ] || ok=0
  # The secrets file decrypts too (without it n8n's credentials cannot be read).
  secret_key=N8N_ENCRYPTION_KEY
else
  secret_key=JWT_ACCESS_SECRET
fi
decrypt demo.env.age | grep -qE "^$secret_key=.{32,}" || {
  log "demo.env.age does not decrypt to a secrets file with $secret_key"
  ok=0
}

if [ "$ok" -ne 1 ]; then
  log "RESTORE TEST FAILED"
  [ -n "$hc" ] && curl -fsS -m 10 -o /dev/null "$hc/fail" || true
  exit 1
fi
log "RESTORE TEST PASSED — the throw-away database is removed now"
[ -n "$hc" ] && curl -fsS -m 10 -o /dev/null "$hc" || true
