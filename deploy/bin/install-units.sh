#!/usr/bin/env bash
# Installs / refreshes the systemd units of the current release (deploy.sh runs it). Idempotent.
#   smartops-backup.timer      daily 03:30 (Montevideo) — only once backup.env exists
#   smartops-monitor.timer     every 5 minutes          — only once monitor.env exists
#   smartops-boot-check        after every boot          — the 04:00 security reboots
# The units always call /opt/smartops/current/bin/…, so a deploy switches them to the new
# release through the "current" symlink.
# shellcheck source=deploy/bin/lib.sh
. "$(dirname "$0")/lib.sh"
require_root

src="$(cd "$(dirname "$0")/../systemd" && pwd)"
changed=0
for unit in "$src"/*.service "$src"/*.timer; do
  dest="/etc/systemd/system/$(basename "$unit")"
  if ! cmp -s "$unit" "$dest"; then
    install -m 644 "$unit" "$dest"
    changed=1
  fi
done
[ "$changed" -eq 0 ] || systemctl daemon-reload

systemctl enable smartops-boot-check.service >/dev/null
if [ -f "$SMARTOPS_ETC/backup.env" ]; then
  systemctl enable --now smartops-backup.timer >/dev/null
else
  log "backup.env missing: daily backups NOT enabled yet (runbook: backups)"
fi
if [ -f "$SMARTOPS_ETC/monitor.env" ]; then
  systemctl enable --now smartops-monitor.timer >/dev/null
else
  log "monitor.env missing: monitoring NOT enabled yet (runbook: monitoring)"
fi
log "systemd units installed"
