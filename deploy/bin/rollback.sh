#!/usr/bin/env bash
# Goes back to the previous version (or the one given): its images, its compose file and its
# n8n workflows. The DATABASE IS NOT ROLLED BACK — migrations are forward-only; deploy.sh
# refuses when the database has migrations the older version does not know, unless you
# confirm they are additive (--accept-newer-schema). For a real schema rollback, restore the
# pre-deploy backup (runbook: restore).
#
#   sudo /opt/smartops/current/bin/rollback.sh            → previous version
#   sudo /opt/smartops/current/bin/rollback.sh 0.12.0 [--accept-newer-schema]
# shellcheck source=deploy/bin/lib.sh
. "$(dirname "$0")/lib.sh"
require_root

target="${1:-}"
if [ -z "$target" ] || [[ "$target" == --* ]]; then
  target="$(read_state previous)"
  [ -n "$target" ] || die "no previous version recorded in $STATE_DIR/previous"
else
  shift
fi
current="$(read_state current)"
[ "$target" != "$current" ] || die "$target is already the current version"
log "rolling back: $current → $target (database unchanged)"
exec bash "$(dirname "$0")/deploy.sh" "$target" --rollback --skip-backup "$@"
