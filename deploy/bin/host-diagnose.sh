#!/usr/bin/env bash
# READ-ONLY snapshot of the demo VM (phase 12, M3): what uses the memory of the base system, which
# services and snaps run, the SSH / firewall settings, and (if present) Docker. It changes NOTHING
# and prints no secrets (no environment, no keys, no file contents of /etc/smartops).
#
#   sudo ./host-diagnose.sh > diagnose.txt        (then send diagnose.txt)
#
# Used to decide what to trim on a 1 GB machine (Oracle Cloud Agent plugins, snaps, services)
# BEFORE host-setup.sh, and again after it to confirm the headroom.
set -uo pipefail

section() { printf '\n===== %s\n' "$*"; }
run() {
  printf '$ %s\n' "$*"
  "$@" 2>&1 || true
}
have() { command -v "$1" >/dev/null 2>&1; }

section "when and what"
run date -u
run uname -a
run uptime
[ -r /etc/os-release ] && grep -E '^(PRETTY_NAME|VERSION_ID)=' /etc/os-release
run dpkg --print-architecture
run nproc

section "memory"
run free -m
grep -E '^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree|Shmem|Slab|SReclaimable|AnonPages):' /proc/meminfo
run swapon --show
run sysctl vm.swappiness vm.vfs_cache_pressure

section "top processes by memory (RSS, MiB)"
ps -eo pid,rss,pmem,comm --sort=-rss 2>/dev/null | awk 'NR == 1 {print "PID RSS_MiB %MEM COMMAND"; next} NR <= 26 {printf "%s %d %s %s\n", $1, $2 / 1024, $3, $4}'

section "memory by systemd unit"
if have systemd-cgtop; then
  run systemd-cgtop -m -b -n 1 --depth=3
else
  echo "systemd-cgtop not available"
fi

section "running services"
run systemctl list-units --type=service --state=running --no-pager --plain
section "enabled services"
run systemctl list-unit-files --type=service --state=enabled --no-pager --plain

section "snaps"
if have snap; then
  run snap list
  run snap services
else
  echo "snapd is not installed"
fi

section "Oracle Cloud Agent"
# shellcheck disable=SC2009 # pgrep cannot print the memory of each process
ps -eo pid,rss,comm,args 2>/dev/null | grep -Ei 'oracle-cloud-agent|agent_plugin|oci-' | grep -v grep | awk '{printf "%s %d MiB %s\n", $1, $2 / 1024, $3}'

section "listening ports"
run ss -tlnp

section "SSH (effective settings)"
if have sshd; then
  sshd -T 2>/dev/null | grep -Ei '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin|pubkeyauthentication|allowusers|maxauthtries|allowtcpforwarding) '
fi

section "firewall (INPUT)"
run iptables -S INPUT
have fail2ban-client && run fail2ban-client status

section "disk"
run df -h /
run lsblk

section "Docker"
if have docker; then
  run docker --version
  run docker ps --format 'table {{.Names}}\t{{.Status}}'
  run docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}'
  ps -eo rss,comm 2>/dev/null | awk '$2 ~ /^(dockerd|containerd)$/ {sum[$2] += $1} END {for (n in sum) printf "%s RSS %d MiB\n", n, sum[n] / 1024}'
else
  echo "Docker is not installed"
fi

section "timers and updates"
run systemctl list-timers --no-pager --plain
[ -r /etc/apt/apt.conf.d/20auto-upgrades ] && cat /etc/apt/apt.conf.d/20auto-upgrades
