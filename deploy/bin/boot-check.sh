#!/usr/bin/env bash
# After every boot (systemd, phase 12 — the 04:00 security-update reboots): waits until the
# containers came back by themselves (restart: unless-stopped) and the demo answers through
# Caddy, then reports to its own Healthchecks.io check (HC_BOOT_URL in monitor.env).
# shellcheck source=deploy/bin/lib.sh
. "$(dirname "$0")/lib.sh"
require_root

MONITOR_ENV="${MONITOR_ENV:-$SMARTOPS_ETC/monitor.env}"
hc="$(grep -E '^HC_BOOT_URL=' "$MONITOR_ENV" 2>/dev/null | tail -n 1 | cut -d= -f2- || true)"
version="$(read_state current)"
[ -n "$version" ] || exit 0 # nothing deployed yet

uptime_s="$(cut -d. -f1 /proc/uptime)"
if wait_healthy "$version" 600; then
  if curl_demo /api/v1/health --retry 10 --retry-delay 6 --retry-all-errors; then
    hc_ping "$hc" "" "boot ok: $version healthy $(($(cut -d. -f1 /proc/uptime) - uptime_s))s after the check started"
    exit 0
  fi
fi
hc_ping "$hc" /fail "after the boot, $version did not come back healthy — see: sudo /opt/smartops/current/bin/status.sh"
exit 1
