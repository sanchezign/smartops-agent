#!/usr/bin/env bash
# What the guest sees of its own CPU, minute by minute, to read OCI's "CpuUtilization" metric correctly
# (phase 12 M7). Oracle reclaims an Always Free VM that stays idle for 7 days: CPU p95 < 20 % AND network
# < 20 %. An E2.1.Micro has 1/8 of an OCPU, so it is unknown whether OCI's percentage is relative to the
# whole vCPU the guest sees or to that 1/8 allocation. Run this for ~15 minutes, then compare each minute
# with the Console metric (docs/deploy/cpu-calibration.md):
#
#   ./cpu-calibrate.sh [minutes]        # default 15; needs no root
#
# Output per minute (UTC): busy% = user+nice+system+irq+softirq, steal% = time the hypervisor took the
# CPU away (what throttling a 1/8 OCPU looks like inside the guest), iowait%.
#
# Test seam: PROC_STAT_SEQUENCE=<file with one "cpu …" line per sample> reads those instead of /proc/stat
# and does not sleep.
set -euo pipefail

minutes="${1:-15}"
[[ "$minutes" =~ ^[0-9]+$ ]] && [ "$minutes" -ge 1 ] && [ "$minutes" -le 240 ] || {
  echo "usage: cpu-calibrate.sh [minutes 1-240]" >&2
  exit 2
}
interval="${INTERVAL_S:-60}"

sample_line() { # the n-th snapshot: a "cpu …" line
  if [ -n "${PROC_STAT_SEQUENCE:-}" ]; then
    sed -n "$(($1 + 1))p" "$PROC_STAT_SEQUENCE"
  else
    grep -m1 '^cpu ' /proc/stat
  fi
}

# busy% steal% iowait% between two snapshots (fields: user nice system idle iowait irq softirq steal)
delta() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    n = split(a, x, " "); split(b, y, " ")
    for (i = 2; i <= 9; i++) d[i] = y[i] - x[i]
    total = 0; for (i = 2; i <= 9; i++) total += d[i]
    if (total <= 0) { print "0.0 0.0 0.0"; exit }
    busy = d[2] + d[3] + d[4] + d[7] + d[8]
    printf "%.1f %.1f %.1f\n", 100 * busy / total, 100 * d[9] / total, 100 * d[6] / total
  }'
}

echo "minute (UTC)        busy%  steal%  iowait%"
prev="$(sample_line 0)"
[ -n "$prev" ] || {
  echo "cannot read the CPU counters" >&2
  exit 1
}
busy_list=()
for ((i = 1; i <= minutes; i++)); do
  [ -n "${PROC_STAT_SEQUENCE:-}" ] || sleep "$interval"
  now="$(sample_line "$i")"
  [ -n "$now" ] || break
  read -r busy steal iow < <(delta "$prev" "$now")
  printf '%s  %5s  %6s  %7s\n' "$(date -u +%Y-%m-%dT%H:%MZ)" "$busy" "$steal" "$iow"
  busy_list+=("$busy")
  prev="$now"
done

[ "${#busy_list[@]}" -gt 0 ] || exit 0
printf '%s\n' "${busy_list[@]}" | sort -n | awk '
  { v[NR] = $1; sum += $1 }
  END {
    p = int(0.95 * NR); if (p < 0.95 * NR) p++; if (p < 1) p = 1
    printf "samples=%d  mean busy=%.1f%%  max=%.1f%%  p95=%.1f%%\n", NR, sum / NR, v[NR], v[p]
  }'
echo "Now compare these minutes with Console > Observability > Metrics Explorer > CpuUtilization (docs/deploy/cpu-calibration.md)."
