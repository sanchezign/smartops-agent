#!/usr/bin/env bash
# Shared helpers for the SmartOps server scripts (phase 12). Sourced, never executed.
# Layout on the server:
#   /etc/smartops/demo.env        secrets + settings (root:root 600, created by init-secrets.sh)
#   /etc/smartops/backup.env      backup target + age recipient + Healthchecks URL (600)
#   /etc/smartops/monitor.env     Healthchecks URLs + thresholds (600)
#   /opt/smartops/releases/<v>/   this bundle, extracted from the API image of version <v>
#   /opt/smartops/current         symlink to the running release
#   /opt/smartops/state/          current / previous version, deploy log
#   /opt/smartops/backups/        local encrypted dumps (last 7 days)
# Everything can be overridden for local tests (SMARTOPS_ETC, SMARTOPS_HOME). SMARTOPS_LOCAL=1 is
# the LOCAL TEST HARNESS mode only (scripts/deploy/local-harness.sh): no root / file-mode checks,
# local image tags, no registry pulls. Never set it on the server.

set -euo pipefail

SMARTOPS_ETC="${SMARTOPS_ETC:-/etc/smartops}"
SMARTOPS_HOME="${SMARTOPS_HOME:-/opt/smartops}"
SMARTOPS_ENV_FILE="${SMARTOPS_ENV_FILE:-$SMARTOPS_ETC/demo.env}"
SMARTOPS_PROJECT="${SMARTOPS_PROJECT:-smartops-demo}"
SMARTOPS_IMAGE_PREFIX="${SMARTOPS_IMAGE_PREFIX:-ghcr.io/sanchezign}"
STATE_DIR="$SMARTOPS_HOME/state"
RELEASES_DIR="$SMARTOPS_HOME/releases"
SMARTOPS_LOCAL="${SMARTOPS_LOCAL:-0}"
export SMARTOPS_IMAGE_PREFIX
# Git Bash (local harness on Windows) rewrites /paths in docker arguments; harmless on Linux.
export MSYS_NO_PATHCONV=1

log() { printf '%s  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() {
  log "ERROR: $*"
  exit 1
}

require_root() {
  if [ "$SMARTOPS_LOCAL" != "1" ] && [ "$(id -u)" -ne 0 ]; then
    die "run it with sudo (it manages Docker and root-only secrets)"
  fi
}

# Semantic version only (the image tags that release.yml publishes): 0.12.0, 1.0.0 …
valid_version() { [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || [[ "$SMARTOPS_LOCAL" = "1" &&"$1" =~ ^[0-9A-Za-z._-]+$ ]]; }

# File permissions of a secrets file: must be a regular file, mode 600 (or 400).
check_secret_file() {
  local file="$1"
  [ -f "$file" ] || die "$file does not exist (run init-secrets.sh first)"
  [ "$SMARTOPS_LOCAL" = "1" ] && return 0
  local mode
  mode="$(stat -c '%a' "$file")"
  case "$mode" in
    600 | 400) ;;
    *) die "$file has mode $mode: it must be 600 (chmod 600 $file)" ;;
  esac
}

# The public demo must never HOLD a real key (phase 9 checklist, phase 12). Values are never
# printed, only the variable names. The API checks the same at startup (env.ts).
assert_no_real_keys() {
  local file="$1" found
  found="$(grep -nE '^[A-Z0-9_]+=["'\'']?(sk-ant-|gsk_|sk-proj-|EAA[A-Za-z0-9]{20})' "$file" | cut -d= -f1 || true)"
  if [ -n "$found" ]; then
    die "$file holds what looks like a real provider key (${found//$'\n'/, }) — never on the public demo"
  fi
  if grep -qE '^(ANTHROPIC_API_KEY|TRANSCRIPTION_API_KEY|DEMO_ADMIN_PASSWORD)=.+' "$file"; then
    die "$file sets ANTHROPIC_API_KEY, TRANSCRIPTION_API_KEY or DEMO_ADMIN_PASSWORD — not on the public demo"
  fi
}

# Profile of this server: "full" (n8n; the default) or "light" (ADR-025: no n8n, API + worker +
# orchestrator in one process, for a 1 GB machine). Set by init-secrets.sh --profile.
demo_profile() {
  local p
  p="$(grep -E '^DEMO_PROFILE=' "$SMARTOPS_ENV_FILE" 2>/dev/null | tail -n 1 | cut -d= -f2- || true)"
  case "${p:-full}" in
    light) echo light ;;
    *) echo full ;;
  esac
}
is_light() { [ "$(demo_profile)" = "light" ]; }

# `docker compose` for one release, with the secrets file and the project name.
compose_for() {
  local version="$1" file=compose.yaml
  shift
  is_light && file=compose.light.yaml
  SMARTOPS_VERSION="$version" docker compose \
    --project-name "$SMARTOPS_PROJECT" \
    --project-directory "$RELEASES_DIR/$version" \
    -f "$RELEASES_DIR/$version/$file" \
    --env-file "$SMARTOPS_ENV_FILE" \
    "$@"
}

# One variable of the secrets file, without sourcing it (values may contain spaces / quotes).
env_value() { grep -E "^$1=" "$SMARTOPS_ENV_FILE" | tail -n 1 | cut -d= -f2- || true; }

read_state() { cat "$STATE_DIR/$1" 2>/dev/null || true; }

# The keep-alive load (ADR-027): "off" (also when the file is missing), "on", or "on, running now".
# Information only: the monitor shows it and never raises a problem because of it.
keepalive_state() {
  local file="${KEEPALIVE_ENV:-$SMARTOPS_ETC/keepalive.env}" flag=""
  [ -f "$file" ] && flag="$(grep -E '^KEEPALIVE_LOAD=' "$file" | tail -n 1 | cut -d= -f2- || true)"
  if [ "$flag" != "on" ]; then
    echo off
  elif command -v systemctl >/dev/null 2>&1 && [ "$(systemctl is-active smartops-keepalive.service 2>/dev/null || true)" = "activating" ]; then
    echo "on, running now"
  else
    echo on
  fi
}

write_state() {
  mkdir -p "$STATE_DIR"
  printf '%s\n' "$2" >"$STATE_DIR/$1.tmp"
  mv "$STATE_DIR/$1.tmp" "$STATE_DIR/$1"
}

# Waits until every service with a healthcheck reports healthy (and none is restarting).
wait_healthy() {
  local version="$1" timeout="${2:-300}" start now bad
  start="$(date +%s)"
  while :; do
    bad="$(compose_for "$version" ps --format '{{.Service}} {{.State}} {{.Health}}' |
      awk '$2 != "running" || ($3 != "" && $3 != "healthy") {print $1 "(" $2 "/" $3 ")"}')"
    [ -z "$bad" ] && return 0
    now="$(date +%s)"
    if [ $((now - start)) -ge "$timeout" ]; then
      log "not healthy after ${timeout}s: $bad"
      return 1
    fi
    sleep 5
  done
}

# GET https://<DEMO_DOMAIN><path> THROUGH the local Caddy (the public name resolved to this
# machine), like a visitor. The local harness trusts Caddy's internal CA (-k).
curl_demo() {
  local path="$1" domain
  shift
  domain="$(env_value DEMO_DOMAIN)"
  local opts=(-fsS -m 15 --resolve "$domain:443:127.0.0.1" -o /dev/null)
  [ "$SMARTOPS_LOCAL" = "1" ] && opts+=(-k)
  curl "${opts[@]}" "$@" "https://$domain$path"
}

# Pings a Healthchecks.io URL (success, /fail or /start). Never fails the caller.
hc_ping() {
  local url="$1" suffix="${2:-}" body="${3:-}"
  [ -n "$url" ] || return 0
  curl -fsS -m 10 --retry 3 -o /dev/null --data-raw "$body" "$url$suffix" || log "healthchecks ping failed ($suffix)"
}
