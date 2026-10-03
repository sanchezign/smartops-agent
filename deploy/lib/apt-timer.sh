#!/usr/bin/env bash
# Sourced by deploy/bin/host-setup.sh (never executed). Renders the systemd drop-in that moves the
# apt-daily / apt-daily-upgrade timers to a fixed time. Kept apart so a test can run it and have
# systemd itself judge the result (apps/api/test/unit/apt-timer.test.ts).
#
# 0.12.3 shipped a drop-in with `OnCalendar=*-*-* 20` (the minutes of "02:20") because the time was
# cut out of a "name:HH:MM" string with the wrong expansion; systemd rejected it ("Failed to parse
# calendar specification") and the automatic updates never ran. A time is now validated first.

# render_apt_timer HH:MM[:SS]  →  the drop-in on stdout (exit 1 on an invalid time)
render_apt_timer() {
  local at="${1:-}"
  if [[ ! "$at" =~ ^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$ ]]; then
    echo "invalid time for a timer: '$at' (expected HH:MM or HH:MM:SS)" >&2
    return 1
  fi
  [[ "$at" =~ ^[0-9]{2}:[0-9]{2}$ ]] && at="$at:00"
  printf '[Timer]\nOnCalendar=\nOnCalendar=*-*-* %s\nRandomizedDelaySec=5min\nPersistent=true\n' "$at"
}
