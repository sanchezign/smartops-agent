#!/usr/bin/env bash
# Health of the server every 5 minutes (systemd timer, phase 12): disk, memory, containers and
# the demo through Caddy. Reports to a Healthchecks.io check: success when everything is fine,
# /fail with the list of problems otherwise — Healthchecks emails you on a failure AND when the
# pings stop (server down, timer broken).
#
# /etc/smartops/monitor.env (root, 600):
#   HC_MONITOR_URL=https://hc-ping.com/<uuid>
#   DISK_MAX_PCT=85            (root filesystem)
#   MEM_MIN_AVAILABLE_MB=400   (default 400; 100 in the light profile — a 1 GB machine)
# shellcheck source=deploy/bin/lib.sh
. "$(dirname "$0")/lib.sh"
require_root

MONITOR_ENV="${MONITOR_ENV:-$SMARTOPS_ETC/monitor.env}"
cfg() { grep -E "^$1=" "$MONITOR_ENV" 2>/dev/null | tail -n 1 | cut -d= -f2- || true; }
hc="$(cfg HC_MONITOR_URL)"
disk_max="$(cfg DISK_MAX_PCT)"
disk_max="${disk_max:-85}"
mem_min="$(cfg MEM_MIN_AVAILABLE_MB)"
mem_min="${mem_min:-$(is_light && echo 100 || echo 400)}" # a 1 GB machine (light) has less to spare

problems=()
disk="$(df --output=pcent / | tail -n 1 | tr -dc '0-9')"
[ "$disk" -le "$disk_max" ] || problems+=("disk ${disk}% used (max ${disk_max}%)")
mem="$(awk '/^MemAvailable:/ {print int($2 / 1024)}' /proc/meminfo 2>/dev/null || true)"
if [ -z "$mem" ]; then
  [ "$SMARTOPS_LOCAL" = "1" ] || problems+=("cannot read MemAvailable from /proc/meminfo")
  mem="?"
elif [ "$mem" -lt "$mem_min" ]; then
  problems+=("only ${mem} MB of memory available (min ${mem_min})")
fi

version="$(read_state current)"
if [ -z "$version" ]; then
  problems+=("no version deployed")
else
  bad="$(compose_for "$version" ps --all --format '{{.Service}} {{.State}} {{.Health}}' |
    awk '$1 != "migrate" && $1 != "seed" && ($2 != "running" || ($3 != "" && $3 != "healthy")) {print $1 "(" $2 "/" $3 ")"}' |
    tr '\n' ' ')"
  [ -z "$bad" ] || problems+=("containers: $bad")
  curl_demo /api/v1/health 2>/dev/null ||
    problems+=("https://$(env_value DEMO_DOMAIN)/api/v1/health does not answer through Caddy")
fi

# The keep-alive load is shown, never judged: the monitor has no CPU threshold, so a night with it
# running cannot raise a problem (monitor-keepalive.test.ts).
summary="disk ${disk}% · mem available ${mem} MB · version ${version:-none} · keepalive $(keepalive_state)"
if [ "${#problems[@]}" -eq 0 ]; then
  hc_ping "$hc" "" "ok — $summary"
else
  report="$(printf '%s\n' "${problems[@]}")"
  hc_ping "$hc" /fail "$report
$summary"
  log "problems: ${problems[*]}"
  exit 1
fi
