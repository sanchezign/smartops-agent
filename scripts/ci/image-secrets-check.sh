#!/usr/bin/env bash
# Image secrets check (phase 11 M4, user rule): an image must never contain a .env file, a
# private key or a secret-looking variable, and its application files must pass gitleaks.
#   scripts/ci/image-secrets-check.sh <image> <dir inside the image> [<dir> …]
#   e.g. smartops-api:ci /app /opt/smartops-deploy   (the deploy bundle, phase 12)
set -euo pipefail
export MSYS_NO_PATHCONV=1 # local Windows runs (Git Bash); harmless on Linux

image="$1"
shift
appdirs=("$@")
[ "${#appdirs[@]}" -gt 0 ] || {
  echo "usage: image-secrets-check.sh <image> <dir> [<dir> …]" >&2
  exit 2
}
gitleaks_image="ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f"
fail=0
work="$(mktemp -d)"
trap 'rm -rf "$work"; docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT

# 1. Environment baked into the image config: no secret-looking variable names.
envs="$(docker image inspect "$image" --format '{{range .Config.Env}}{{println .}}{{end}}')"
if echo "$envs" | grep -iE '^[A-Z0-9_]*(SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE)[A-Z0-9_]*=' ; then
  echo "::error::$image: secret-looking variable in the image configuration (above)"
  fail=1
fi

# 2. Every file of the whole filesystem: no .env (examples allowed), no keys, no simulator data.
cid="$(docker create "$image")"
docker export "$cid" | tar -t > "$work/files.txt"
if grep -E '(^|/)\.env(\.[A-Za-z0-9_-]+)?$' "$work/files.txt" | grep -vE '\.example$' \
  | grep -vE '^usr/|/node_modules/' ; then
  echo "::error::$image contains .env files (above)"
  fail=1
fi
if grep -E '(^|/)(id_rsa|id_ed25519)$|\.pem$|\.p12$|\.pfx$|(^|/)\.sim/' "$work/files.txt" \
  | grep -vE '^(usr|etc)/|/node_modules/' ; then
  echo "::error::$image contains keys or simulator data (above)"
  fail=1
fi

# 3. The application files (not node_modules: third-party test fixtures would be noise).
mkdir -p "$work/app"
docker export "$cid" | tar -x -C "$work/app" --exclude='node_modules' "${appdirs[@]#/}"
for dir in "${appdirs[@]}"; do
  if [ "$(find "$work/app/${dir#/}" -type f 2>/dev/null | wc -l)" -eq 0 ]; then
    echo "::error::$image: nothing extracted from $dir — the check would be empty"
    exit 1
  fi
done
count="$(find "$work/app" -type f | wc -l)"
echo "scanning $count application files"
mkdir -p "$work/app/.cfg" && cp "$(dirname "$0")/gitleaks-image.toml" "$work/app/.cfg/"
mount="$work/app"
if command -v cygpath >/dev/null 2>&1; then mount="$(cygpath -w "$mount")"; fi # local Windows runs
if ! docker run --rm -v "$mount:/scan:ro" "$gitleaks_image" dir /scan --config /scan/.cfg/gitleaks-image.toml --redact --no-banner; then
  echo "::error::$image: gitleaks found a secret in the application files"
  fail=1
fi

if [ "$fail" -ne 0 ]; then exit 1; fi
echo "OK: $image has no .env, keys, secret variables or leaked secrets"
