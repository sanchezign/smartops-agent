#!/usr/bin/env bash
# One-screen status of the demo server (phase 12): versions, containers, resources, backups.
# shellcheck source=deploy/bin/lib.sh
. "$(dirname "$0")/lib.sh"
require_root

version="$(read_state current)"
echo "current version:  ${version:-none}"
echo "previous version: $(read_state previous)"
echo "last deploys:"
tail -n 5 "$STATE_DIR/deploy.log" 2>/dev/null | sed 's/^/  /' || true
echo
if [ -n "$version" ]; then
  # Our own header: with "table" Compose has no column title for .Health and printed "<no value>".
  compose_for "$version" ps --format '{{.Service}}\t{{.State}}\t{{.Health}}\t{{.RunningFor}}' |
    awk -F'\t' 'BEGIN { printf "%-10s %-9s %-10s %s\n", "SERVICE", "STATE", "HEALTH", "UP FOR" }
      { printf "%-10s %-9s %-10s %s\n", $1, $2, ($3 == "" ? "-" : $3), $4 }'
  echo
  docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' |
    grep -E "NAME|$SMARTOPS_PROJECT" || true
  echo
fi
echo "disk: $(df -h --output=used,size,pcent / | tail -n 1)"
echo "memory: $(free -m | awk '/^Mem:/ {print $3 " MB used, " $7 " MB available of " $2}')"
echo "uptime: $(uptime -p)"
echo "last backups:"
find "$SMARTOPS_HOME/backups" -mindepth 1 -maxdepth 1 -type d -printf '  %f\n' 2>/dev/null | sort | tail -n 3
echo "timers:"
systemctl list-timers 'smartops-*' --no-pager 2>/dev/null | sed 's/^/  /' | head -n 6 || true
