#!/usr/bin/env bash
# Creates / completes the demo's secrets file ON THE SERVER (phase 12). Idempotent: only the
# variables that are missing are generated; an existing value is NEVER overwritten (rotating
# one is a runbook step). Values never leave this file: nothing is printed, nothing is logged.
#
#   sudo ./init-secrets.sh --domain smartops-demo.duckdns.org [--profile light|full]
#
# --profile light = the 1 GB profile (ADR-025): no n8n keys are generated. Default: full (n8n).
# The profile is recorded as DEMO_PROFILE and never changes by itself.
#
# Result: /etc/smartops/demo.env, root:root, mode 600.
# shellcheck source=deploy/bin/lib.sh
. "$(dirname "$0")/lib.sh"
require_root

domain=""
profile=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domain)
      domain="${2:-}"
      shift 2
      ;;
    --profile)
      profile="${2:-}"
      shift 2
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

umask 077
mkdir -p "$SMARTOPS_ETC"
chmod 700 "$SMARTOPS_ETC"
touch "$SMARTOPS_ENV_FILE"
chmod 600 "$SMARTOPS_ENV_FILE"

has() { grep -qE "^$1=" "$SMARTOPS_ENV_FILE"; }
add() {
  printf '%s=%s\n' "$1" "$2" >>"$SMARTOPS_ENV_FILE"
  log "added $1"
}
random() { openssl rand -hex 32; } # 256 bits, [0-9a-f] only (safe in env files and URLs)

if ! has DEMO_DOMAIN; then
  [ -n "$domain" ] || die "first run: pass --domain <the demo's public host name>"
  [[ "$domain" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || die "invalid domain: $domain"
  add DEMO_DOMAIN "$domain"
elif [ -n "$domain" ] && ! grep -qxF "DEMO_DOMAIN=$domain" "$SMARTOPS_ENV_FILE"; then
  die "DEMO_DOMAIN is already set to another value; edit $SMARTOPS_ENV_FILE on purpose to change it"
fi

case "$profile" in
  "" | light | full) ;;
  *) die "--profile must be light or full" ;;
esac
if has DEMO_PROFILE; then
  current="$(grep -E '^DEMO_PROFILE=' "$SMARTOPS_ENV_FILE" | tail -n 1 | cut -d= -f2-)"
  [ -z "$profile" ] || [ "$profile" = "$current" ] ||
    die "DEMO_PROFILE is already $current; edit $SMARTOPS_ENV_FILE on purpose to change it"
  profile="$current"
else
  profile="${profile:-full}"
  add DEMO_PROFILE "$profile"
fi

keys=(POSTGRES_SUPERUSER_PASSWORD POSTGRES_APP_PASSWORD INTERNAL_API_KEY JWT_ACCESS_SECRET
  DEMO_FAKE_WHATSAPP_TOKEN DEMO_FAKE_WHATSAPP_APP_SECRET DEMO_FAKE_WHATSAPP_VERIFY_TOKEN)
# n8n's own secrets only exist in the full profile.
[ "$profile" = "full" ] && keys+=(N8N_DB_PASSWORD N8N_ENCRYPTION_KEY N8N_WEBHOOK_SECRET)
for key in "${keys[@]}"; do
  has "$key" || add "$key" "$(random)"
done

assert_no_real_keys "$SMARTOPS_ENV_FILE"
log "secrets file ready: $SMARTOPS_ENV_FILE (mode $(stat -c '%a' "$SMARTOPS_ENV_FILE"))"
