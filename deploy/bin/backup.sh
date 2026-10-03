#!/usr/bin/env bash
# Encrypted backup of the demo (phase 12, ADR-023): both databases (app + n8n) and the secrets
# file (n8n's credentials are useless without N8N_ENCRYPTION_KEY), encrypted with age to the
# owner's PUBLIC key. The private key never touches this server: a stolen server cannot read
# old backups, and restores are tested on the owner's PC (restore-test.sh, user addendum B).
#
#   sudo ./backup.sh [--reason daily|pre-deploy-<v>|manual] [--version <v>]
#
# /etc/smartops/backup.env (root, 600):
#   BACKUP_AGE_RECIPIENT=age1…            the owner's public key (required)
#   BACKUP_TARGET=oci | dir | none        oci = Object Storage with the instance principal
#   OCI_BUCKET=smartops-backups           (oci) bucket; retention by its lifecycle policy (30 days)
#   OCI_NAMESPACE=<tenancy namespace>     (oci) Object Storage namespace (passed explicitly: the VM's
#                                         policy does not allow looking it up, nor anything else)
#   BACKUP_DIR_TARGET=/mnt/…              (dir) copy target — local tests only
#   HC_BACKUP_URL=https://hc-ping.com/…   Healthchecks.io check (optional)
# Local copies: /opt/smartops/backups/<UTC>-<reason>/, kept 7 days.
# shellcheck source=deploy/bin/lib.sh
. "$(dirname "$0")/lib.sh"
require_root

reason="manual"
version="$(read_state current)"
while [ $# -gt 0 ]; do
  case "$1" in
    --reason)
      reason="${2:-}"
      shift 2
      ;;
    --version)
      version="${2:-}"
      shift 2
      ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ "$reason" =~ ^[a-z0-9._-]+$ ]] || die "invalid --reason"
[ -n "$version" ] || die "no current version recorded (deploy first, or pass --version)"

BACKUP_ENV="${BACKUP_ENV:-$SMARTOPS_ETC/backup.env}"
check_secret_file "$BACKUP_ENV"
cfg() { grep -E "^$1=" "$BACKUP_ENV" | tail -n 1 | cut -d= -f2- || true; }
recipient="$(cfg BACKUP_AGE_RECIPIENT)"
target="$(cfg BACKUP_TARGET)"
target="${target:-none}"
hc="$(cfg HC_BACKUP_URL)"
[[ "$recipient" =~ ^age1[0-9a-z]{58}$ ]] || die "BACKUP_AGE_RECIPIENT must be an age public key (age1…)"

OCI_CLI_IMAGE="ghcr.io/oracle/oci-cli:20260923@sha256:8732a1bb9ceaca5d84cedb9cb5c6020817497291280ffa9f292d7e9950a76485"
# Local test harness only: a fake CLI image (and docker arguments to record what it received).
OCI_LOCAL_DOCKER_ARGS=()
if [ "$SMARTOPS_LOCAL" = "1" ] && [ -n "${SMARTOPS_OCI_CLI_IMAGE:-}" ]; then
  OCI_CLI_IMAGE="$SMARTOPS_OCI_CLI_IMAGE"
  # shellcheck disable=SC2206 # a space-separated list of docker options, set by the harness
  OCI_LOCAL_DOCKER_ARGS=(${SMARTOPS_OCI_DOCKER_ARGS:-})
fi
AGE_IMAGE="alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6"

# age from the host (apt install age); the local test harness falls back to a container.
encrypt() {
  if command -v age >/dev/null 2>&1; then
    age -r "$recipient"
  else
    docker run --rm -i "$AGE_IMAGE" sh -c "apk add -q --no-cache age >/dev/null && age -r '$recipient'"
  fi
}

# Lowest MemAvailable (MB) seen while the backup runs: the machine is tiny (1 GB), so every run says
# how close it came (measured 2026-10-03: the whole pipeline is ~100 MB at its peak).
mem_samples="$(mktemp)"
(while :; do
  awk '/^MemAvailable:/ {print int($2 / 1024)}' /proc/meminfo 2>/dev/null
  sleep 1
done) >"$mem_samples" 2>/dev/null &
sampler=$!
trap 'kill "$sampler" 2>/dev/null || true; rm -f "$mem_samples"' EXIT

hc_ping "$hc" /start
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dir="$SMARTOPS_HOME/backups/$stamp-$reason"
umask 077
mkdir -p "$dir"
fail() {
  hc_ping "$hc" /fail "backup $stamp-$reason failed: $1"
  die "$1"
}

databases=(smartops_demo)
is_light || databases+=(n8n) # the light profile has no n8n database (ADR-025)
for db in "${databases[@]}"; do
  log "dumping $db"
  compose_for "$version" exec -T postgres pg_dump -U postgres -Fc --no-owner -d "$db" | encrypt >"$dir/$db.dump.age" ||
    fail "pg_dump of $db failed"
  [ -s "$dir/$db.dump.age" ] || fail "empty dump of $db"
done
encrypt <"$SMARTOPS_ENV_FILE" >"$dir/demo.env.age" || fail "could not encrypt the secrets file"
{
  echo "created=$stamp"
  echo "reason=$reason"
  echo "version=$version"
  (cd "$dir" && sha256sum ./*.age)
} >"$dir/manifest.txt"

case "$target" in
  oci)
    bucket="$(cfg OCI_BUCKET)"
    namespace="$(cfg OCI_NAMESPACE)"
    [ -n "$bucket" ] || fail "OCI_BUCKET is not set"
    [ -n "$namespace" ] || fail "OCI_NAMESPACE is not set"
    # The VM may only CREATE objects in this bucket (instance principal, append-only policy): every
    # name is unique (UTC stamp), --no-overwrite never replaces one, and nothing here can delete.
    # The container runs as root with no capabilities: the files are root's, mode 600 (umask 077) and
    # the image's own user could not read them. Memory is capped (measured peak ~60 MiB).
    for file in "$dir"/*; do
      uploaded=0
      for attempt in 1 2 3; do
        if docker run --rm --user 0:0 --cap-drop ALL --security-opt no-new-privileges:true --memory 192m \
          "${OCI_LOCAL_DOCKER_ARGS[@]}" -v "$dir:/b:ro" "$OCI_CLI_IMAGE" \
          --auth instance_principal os object put --namespace-name "$namespace" --bucket-name "$bucket" \
          --file "/b/$(basename "$file")" --name "$stamp-$reason/$(basename "$file")" \
          --no-multipart --no-overwrite >/dev/null; then
          uploaded=1
          break
        fi
        log "upload of $(basename "$file") failed (attempt $attempt of 3)"
        sleep $((attempt * 5))
      done
      [ "$uploaded" -eq 1 ] || fail "upload of $(basename "$file") failed"
    done
    log "uploaded to bucket $bucket as $stamp-$reason/"
    ;;
  dir)
    dest="$(cfg BACKUP_DIR_TARGET)"
    [ -n "$dest" ] || fail "BACKUP_DIR_TARGET is not set"
    mkdir -p "$dest"
    cp -r "$dir" "$dest/"
    log "copied to $dest/$stamp-$reason"
    ;;
  none) log "BACKUP_TARGET=none: local copy only" ;;
  *) fail "unknown BACKUP_TARGET: $target" ;;
esac

# Local copies: 7 days (the bucket's lifecycle policy keeps 30).
find "$SMARTOPS_HOME/backups" -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} +
size="$(du -sh "$dir" | cut -f1)"
min_mem="$(sort -n "$mem_samples" 2>/dev/null | head -n 1)"
min_mem="${min_mem:-?}"
hc_ping "$hc" "" "backup $stamp-$reason ok ($size, version $version, target $target, min available memory ${min_mem} MB)"
log "backup $stamp-$reason ok ($size; lowest available memory during the backup: ${min_mem} MB)"
