#!/usr/bin/env bash
# Checks the Healthchecks.io ping URLs configured on this server (phase 12 M6) without touching
# the checks' status:
#
#   sudo ./hc-test.sh                 # a "/log" ping to each configured URL, and a verdict
#   sudo ./hc-test.sh --fail monitor  # a real "/fail" to ONE check, to prove the alert email arrives
#                                     # (monitor | boot | backup); the next real run turns it green again
#
# URLs come from /etc/smartops/monitor.env (HC_MONITOR_URL, HC_BOOT_URL) and
# /etc/smartops/backup.env (HC_BACKUP_URL). They are secrets in practice (anyone with one can fake a
# ping): this script never prints them, only the check names and the result.
#
# Healthchecks answers "200 OK (not found)" for a well-formed UUID that does not exist, so a typo
# looks like success: the BODY is checked, not only the status code.
# shellcheck source=deploy/bin/lib.sh
. "$(dirname "$0")/lib.sh"
require_root

fail_target=""
while [ $# -gt 0 ]; do
  case "$1" in
    --fail)
      fail_target="${2:-}"
      shift 2
      ;;
    *) die "unknown argument: $1" ;;
  esac
done
case "$fail_target" in "" | monitor | boot | backup) ;; *) die "--fail takes monitor, boot or backup" ;; esac

MONITOR_ENV="${MONITOR_ENV:-$SMARTOPS_ETC/monitor.env}"
BACKUP_ENV="${BACKUP_ENV:-$SMARTOPS_ETC/backup.env}"
value() { # file key
  [ -f "$1" ] || return 0
  grep -E "^$2=" "$1" | tail -n 1 | cut -d= -f2- || true
}

# A UUID URL, or <ping-key>/<slug> (Healthchecks' two documented forms), over https.
valid_url() {
  [[ "$1" =~ ^https://hc-ping\.com/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] ||
    [[ "$1" =~ ^https://hc-ping\.com/[A-Za-z0-9_-]{8,}/[a-z0-9_-]+$ ]]
}

problems=0
tested=0
test_one() { # name, url, what each check is for
  local name="$1" url="$2" purpose="$3" suffix="/log" body code
  [ -z "$fail_target" ] || [ "$fail_target" = "$name" ] || return 0
  if [ -z "$url" ]; then
    echo "SKIP  $name: not configured ($purpose)"
    return 0
  fi
  if ! valid_url "$url"; then
    echo "FAIL  $name: the URL is not a Healthchecks ping URL (https://hc-ping.com/<uuid>)"
    problems=$((problems + 1))
    return 0
  fi
  [ "$fail_target" = "$name" ] && suffix="/fail"
  tested=$((tested + 1))
  body="$(mktemp)"
  code="$(curl -sS -m 10 --retry 2 -o "$body" -w '%{http_code}' --data-raw "hc-test from $(hostname)" "$url$suffix" 2>/dev/null || echo 000)"
  if [ "$code" = "200" ] && grep -qx 'OK' "$body"; then
    if [ "$suffix" = "/fail" ]; then
      echo "SENT  $name: a /fail was recorded: the check must turn red and the alert email must arrive."
      echo "      It turns green again with the next real run ($purpose)."
    else
      echo "PASS  $name: the check exists and answered ($purpose)"
    fi
  elif [ "$code" = "200" ]; then
    echo "FAIL  $name: Healthchecks says the check does not exist (\"$(tr -d '\n' <"$body" | cut -c1-40)\"): wrong UUID?"
    problems=$((problems + 1))
  else
    echo "FAIL  $name: HTTP $code (no network to hc-ping.com, a wrong URL, or more than 5 pings a minute)"
    problems=$((problems + 1))
  fi
  rm -f "$body"
}

test_one monitor "$(value "$MONITOR_ENV" HC_MONITOR_URL)" "every 5 minutes: sudo systemctl start smartops-monitor.service"
test_one boot "$(value "$MONITOR_ENV" HC_BOOT_URL)" "after a boot: sudo systemctl start smartops-boot-check.service"
test_one backup "$(value "$BACKUP_ENV" HC_BACKUP_URL)" "the next backup: sudo $(dirname "$0")/backup.sh --reason manual"

if [ "$problems" -ne 0 ]; then
  echo "HC TEST FAILED ($problems): fix the URL in monitor.env / backup.env (docs/deploy/monitoring.md)."
  exit 1
fi
[ "$tested" -gt 0 ] || die "no Healthchecks URL is configured: nothing to test"
echo "HC TEST PASSED ($tested checked)."
