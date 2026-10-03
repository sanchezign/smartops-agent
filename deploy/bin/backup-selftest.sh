#!/usr/bin/env bash
# Proves, from the VM itself and with its real instance-principal identity, that the backup
# bucket is APPEND-ONLY for it (phase 12 M5): it can create objects and list them, and it can NOT
# overwrite, delete or read one. A stolen VM therefore cannot destroy or leak the backups.
#
#   sudo ./backup-selftest.sh
#
# It leaves ONE tiny object under selftest/<UTC stamp>/ (nothing can delete it; the bucket's
# lifecycle rule removes it after 30 days). Reads OCI_BUCKET / OCI_NAMESPACE from
# /etc/smartops/backup.env. Exit code 0 only if every check behaves as the policy says.
# shellcheck source=deploy/bin/lib.sh
. "$(dirname "$0")/lib.sh"
require_root

BACKUP_ENV="${BACKUP_ENV:-$SMARTOPS_ETC/backup.env}"
check_secret_file "$BACKUP_ENV"
cfg() { grep -E "^$1=" "$BACKUP_ENV" | tail -n 1 | cut -d= -f2- || true; }
bucket="$(cfg OCI_BUCKET)"
namespace="$(cfg OCI_NAMESPACE)"
[ -n "$bucket" ] && [ -n "$namespace" ] || die "OCI_BUCKET and OCI_NAMESPACE must be set in $BACKUP_ENV"

# Same pinned image as backup.sh (a test keeps the two literals identical).
OCI_CLI_IMAGE="ghcr.io/oracle/oci-cli:20260923@sha256:8732a1bb9ceaca5d84cedb9cb5c6020817497291280ffa9f292d7e9950a76485"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
name="selftest/$stamp/probe.txt"
printf 'backup-selftest %s\n' "$stamp" >"$work/probe.txt"

cli() { # runs the OCI CLI with the VM's identity; prints nothing (only the exit code matters)
  docker run --rm --user 0:0 --cap-drop ALL --security-opt no-new-privileges:true --memory 192m \
    -v "$work:/w" "$OCI_CLI_IMAGE" --auth instance_principal "$@" >/dev/null 2>"$work/last.err"
}
failures=0
expect_ok() { # description, command…
  local what="$1"
  shift
  if "$@"; then echo "PASS  $what"; else
    echo "FAIL  $what (it should work): $(tr '\n' ' ' <"$work/last.err" | cut -c1-200)"
    failures=$((failures + 1))
  fi
}
expect_denied() {
  local what="$1"
  shift
  if "$@"; then
    echo "FAIL  $what (it WORKED, it must be refused)"
    failures=$((failures + 1))
  else echo "PASS  $what -> refused"; fi
}

echo "bucket $bucket (namespace $namespace), probe object $name"
expect_ok "create a new object" cli os object put --namespace-name "$namespace" --bucket-name "$bucket" \
  --file /w/probe.txt --name "$name" --no-multipart --no-overwrite
expect_ok "list objects (needed to check before writing)" cli os object list --namespace-name "$namespace" \
  --bucket-name "$bucket" --prefix "selftest/$stamp/" --limit 1
expect_denied "write the same name again (--no-overwrite)" cli os object put --namespace-name "$namespace" \
  --bucket-name "$bucket" --file /w/probe.txt --name "$name" --no-multipart --no-overwrite
expect_denied "overwrite it (--force)" cli os object put --namespace-name "$namespace" --bucket-name "$bucket" \
  --file /w/probe.txt --name "$name" --no-multipart --force
expect_denied "delete it" cli os object delete --namespace-name "$namespace" --bucket-name "$bucket" \
  --object-name "$name" --force
expect_denied "read it back" cli os object get --namespace-name "$namespace" --bucket-name "$bucket" \
  --name "$name" --file /w/readback.txt
expect_denied "delete the bucket" cli os bucket delete --namespace-name "$namespace" --bucket-name "$bucket" --force

if [ "$failures" -eq 0 ]; then
  echo "SELFTEST PASSED: this VM can only append to the backup bucket."
else
  echo "SELFTEST FAILED ($failures): see docs/deploy/backups.md (troubleshooting)."
  exit 1
fi
