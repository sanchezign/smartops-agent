#!/usr/bin/env bash
# Proves, from the VM itself and with its real instance-principal identity, that the backup
# bucket is APPEND-ONLY for it (phase 12 M5): it can create objects and list them, and it can NOT
# overwrite, delete or read one. A stolen VM therefore cannot destroy or leak the backups.
#
#   sudo ./backup-selftest.sh
#
# It leaves ONE tiny object under selftest/<UTC stamp>/ (nothing can delete it; the bucket's
# lifecycle rule removes it after 30 days).
#
# Why it compares the object instead of trusting exit codes: with --no-overwrite the OCI CLI checks
# first (HEAD) and, if the object exists, SKIPS the upload and exits 0 ("The object already exists
# and was not overwritten"): that is the CLI, not the policy. So "write again" is judged by whether
# the object (etag + size) CHANGED, and the policy itself is proven by the refused --force overwrite. Reads OCI_BUCKET / OCI_NAMESPACE from
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
    -v "$work:/w" "$OCI_CLI_IMAGE" --auth instance_principal "$@" >"$work/out.json" 2>"$work/last.err"
}
fingerprint() { # etag + size of the probe object ("" if it cannot be read)
  cli os object head --namespace-name "$namespace" --bucket-name "$bucket" --name "$name" || return 0
  grep -E '"(etag|content-length)"' "$work/out.json" | tr -d ' \n' || true
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
expect_unchanged() { # description, fingerprint taken before
  local what="$1" before="$2" after
  after="$(fingerprint)"
  if [ -n "$after" ] && [ "$after" = "$before" ]; then echo "PASS  $what -> the object did not change"; else
    echo "FAIL  $what (the object CHANGED or disappeared: before [$before] after [$after])"
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
before="$(fingerprint)"
if [ -z "$before" ]; then
  echo "FAIL  read the new object's etag and size (needs OBJECT_INSPECT)"
  failures=$((failures + 1))
fi
printf 'a different and longer replacement %s\n' "$stamp" >"$work/probe2.txt"
# The CLI may skip (exit 0) or fail: both are fine, what matters is that the object stayed as it was.
cli os object put --namespace-name "$namespace" --bucket-name "$bucket" --file /w/probe2.txt --name "$name" \
  --no-multipart --no-overwrite || true
expect_unchanged "write the same name again (--no-overwrite, the CLI skips it itself)" "$before"
expect_denied "overwrite it (--force): this is the policy" cli os object put --namespace-name "$namespace" \
  --bucket-name "$bucket" --file /w/probe2.txt --name "$name" --no-multipart --force
expect_denied "delete it" cli os object delete --namespace-name "$namespace" --bucket-name "$bucket" \
  --object-name "$name" --force
expect_denied "read it back" cli os object get --namespace-name "$namespace" --bucket-name "$bucket" \
  --name "$name" --file /w/readback.txt
expect_denied "delete the bucket" cli os bucket delete --namespace-name "$namespace" --bucket-name "$bucket" --force
expect_unchanged "after every attempt above" "$before"

if [ "$failures" -eq 0 ]; then
  echo "SELFTEST PASSED: this VM can only append to the backup bucket."
else
  echo "SELFTEST FAILED ($failures): see docs/deploy/backups.md (troubleshooting)."
  exit 1
fi
