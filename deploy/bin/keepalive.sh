#!/usr/bin/env bash
# Switch for the keep-alive load (phase 12, ADR-027, docs/deploy/keepalive.md).
#
#   sudo keepalive.sh status            what is set, when it runs next, how the last run went
#   sudo keepalive.sh test [minutes]    run it ONCE now (default 20 minutes) without changing the saved
#                                       settings: the 20-minute trial before turning it on
#   sudo keepalive.sh on [minutes]      turn the nightly run on (03:00 UTC); minutes 1-120, default 120
#   sudo keepalive.sh off               turn it off (takes effect at once; also stops a run in progress)
#   sudo keepalive.sh stop              stop a run in progress (a test), settings unchanged
#
# The switch is /etc/smartops/keepalive.env (no secrets): KEEPALIVE_LOAD=on|off, KEEPALIVE_MINUTES=N.
# Without the file the load is OFF. The unit re-reads the file every time it starts.
# shellcheck source=deploy/bin/lib.sh
. "$(dirname "$0")/lib.sh"
require_root

KEEPALIVE_ENV="${KEEPALIVE_ENV:-$SMARTOPS_ETC/keepalive.env}"
UNIT="smartops-keepalive.service"
MAX_MINUTES=120

value() { # key → value in the env file ("" when missing)
  [ -f "$KEEPALIVE_ENV" ] || return 0
  grep -E "^$1=" "$KEEPALIVE_ENV" | tail -n 1 | cut -d= -f2- || true
}
valid_minutes() { [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -ge 1 ] && [ "$1" -le "$MAX_MINUTES" ]; }
write_env() { # load minutes
  local tmp
  tmp="$(mktemp "$KEEPALIVE_ENV.XXXXXX")"
  printf 'KEEPALIVE_LOAD=%s\nKEEPALIVE_MINUTES=%s\n' "$1" "$2" >"$tmp"
  chmod 644 "$tmp"
  mv "$tmp" "$KEEPALIVE_ENV"
}
minutes_or_default() { local m="${1:-}"; [ -n "$m" ] || m="$(value KEEPALIVE_MINUTES)"; echo "${m:-120}"; }

cmd="${1:-status}"
shift || true
case "$cmd" in
  status)
    echo "keepalive: $(value KEEPALIVE_LOAD | grep -x on || echo off)  (file: $KEEPALIVE_ENV$([ -f "$KEEPALIVE_ENV" ] || echo ', missing = off'))"
    echo "minutes per night: $(minutes_or_default)  (runs at 03:00 UTC = 00:00 Montevideo, up to 5 min later)"
    if command -v systemctl >/dev/null 2>&1; then
      systemctl list-timers smartops-keepalive.timer --no-pager 2>/dev/null | sed -n '1,2p' || true
      systemctl show "$UNIT" -p ActiveState,Result,ExecMainExitTimestamp --no-pager 2>/dev/null | sed 's/^/  last: /' || true
    fi
    ;;
  on)
    minutes="$(minutes_or_default "${1:-}")"
    valid_minutes "$minutes" || die "minutes must be a number from 1 to $MAX_MINUTES"
    write_env on "$minutes"
    log "keepalive ON: $minutes minutes every night at 03:00 UTC (the next run is shown by: keepalive.sh status)"
    ;;
  off)
    write_env off "$(minutes_or_default)"
    systemctl stop "$UNIT" 2>/dev/null || true
    log "keepalive OFF (a run in progress was stopped)"
    ;;
  stop)
    systemctl stop "$UNIT"
    log "keepalive run stopped (settings unchanged)"
    ;;
  test)
    minutes="${1:-20}"
    valid_minutes "$minutes" || die "minutes must be a number from 1 to $MAX_MINUTES"
    command -v systemctl >/dev/null 2>&1 || die "systemctl not found"
    # Settings to put back: the saved file, or its absence.
    saved=""
    if [ -f "$KEEPALIVE_ENV" ]; then saved="$(mktemp)" && cp -p "$KEEPALIVE_ENV" "$saved"; fi
    restore() {
      if [ -n "$saved" ]; then mv "$saved" "$KEEPALIVE_ENV"; saved=""; else rm -f "$KEEPALIVE_ENV"; fi
    }
    trap restore EXIT
    write_env on "$minutes"
    systemctl start --no-block "$UNIT"
    # The unit reads the file when it starts: once it is running the saved settings can go back.
    for _ in $(seq 1 30); do
      pid="$(systemctl show "$UNIT" -p MainPID --value 2>/dev/null || echo 0)"
      [ "${pid:-0}" != "0" ] && break
      sleep 1
    done
    [ "${pid:-0}" != "0" ] || die "the load did not start: check 'journalctl -u $UNIT'"
    restore
    trap - EXIT
    log "running for $minutes minutes now (priority idle, at most 35 % of one vCPU); saved settings untouched."
    log "watch: sudo cpu-calibrate.sh $minutes   |   stop early: sudo keepalive.sh stop"
    ;;
  *) die "usage: keepalive.sh status | test [minutes] | on [minutes] | off | stop" ;;
esac
