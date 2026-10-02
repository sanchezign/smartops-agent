#!/usr/bin/env bash
# One-time (and re-runnable) hardening + setup of the demo VM — Ubuntu 24.04 on OCI (phase 12).
# Written for the Always Free E2.1.Micro (1 GB, x86_64; ADR-023) and valid on any Ubuntu 24.04 VM.
# Idempotent: every step checks before it changes anything.
#
#   sudo ./host-setup.sh [--admin-user ubuntu] [--profile micro|standard]
#
# --profile micro (default on a machine with < 2 GB of RAM): no fail2ban. Port 22 is only
# reachable from the Bastion subnet (OCI security list) and SSH is keys-only, so fail2ban adds
# little and its Python process costs memory a 1 GB machine does not have. It also:
#   - disables AND masks services a headless VM does not use (firmware updater, multipath, iSCSI,
#     udisks, ModemManager, packagekit, rpcbind — which also listened on port 111 —, VMware tools): ~95 MiB;
#     the Oracle Cloud Agent snap (and so snapd), unattended-upgrades, cloud-init and sysstat stay;
#   - SSH without TCP forwarding (nothing to tunnel without n8n; Postgres is never published)
#     and vm.swappiness=60 (the value the memory simulation was measured with).
#
# What it does:
#   - timezone America/Montevideo (the 03:30 backup and 04:00 reboot are local times)
#   - Docker Engine + compose plugin from Docker's apt repository; logs capped (local driver)
#   - SSH: keys only, no root, only the admin user, no password / keyboard-interactive
#   - host firewall: OCI's Ubuntu images use iptables (/etc/iptables/rules.v4) and Oracle warns
#     NOT to use ufw — 80/443 are inserted BEFORE the image's REJECT rule; nothing else opens
#   - fail2ban for sshd; unattended security upgrades with automatic reboot at 04:00
#   - 2 GB swap, journald capped, /etc/smartops (700) and /opt/smartops
# It never opens Postgres or n8n: only Caddy publishes ports (80/443).
set -euo pipefail

admin_user="ubuntu"
profile=""
while [ $# -gt 0 ]; do
  case "$1" in
    --profile)
      profile="${2:-}"
      shift 2
      ;;
    --admin-user)
      admin_user="${2:-}"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done
if [ -z "$profile" ]; then
  if [ "$(awk '/^MemTotal:/ {print int($2 / 1024)}' /proc/meminfo)" -lt 2048 ]; then profile=micro; else profile=standard; fi
fi
case "$profile" in
  micro | standard) ;;
  *)
    echo "--profile must be micro or standard" >&2
    exit 2
    ;;
esac
[ "$(id -u)" -eq 0 ] || {
  echo "run it with sudo" >&2
  exit 1
}
id "$admin_user" >/dev/null 2>&1 || {
  echo "user $admin_user does not exist" >&2
  exit 1
}
[ -s "$(getent passwd "$admin_user" | cut -d: -f6)/.ssh/authorized_keys" ] || {
  echo "$admin_user has no SSH key: refusing to lock SSH down (you would lose access)" >&2
  exit 1
}
# shellcheck source=/dev/null
. /etc/os-release
[ "${ID:-}" = "ubuntu" ] || echo "WARNING: written for Ubuntu 24.04, this is ${PRETTY_NAME:-unknown}" >&2

log() { printf '== %s\n' "$*"; }
export DEBIAN_FRONTEND=noninteractive

# The image's automatic updates may hold the dpkg lock right when this runs (it happened on the
# first real run: "Could not get lock /var/lib/dpkg/lock-frontend"). Wait for it (up to 10 min),
# say so, and let dpkg wait too.
wait_for_apt() {
  command -v fuser >/dev/null 2>&1 || return 0
  local waited=0
  while fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock >/dev/null 2>&1; do
    [ "$waited" -ne 0 ] || echo "another apt/dpkg process is running (automatic updates?): waiting up to 10 minutes" >&2
    waited=$((waited + 5))
    [ "$waited" -lt 600 ] || {
      echo "apt/dpkg stayed locked for 10 minutes: try again later" >&2
      exit 1
    }
    sleep 5
  done
}
apt_get() {
  wait_for_apt
  apt-get -o DPkg::Lock::Timeout=600 "$@"
}

log "timezone"
timedatectl set-timezone America/Montevideo

log "packages"
apt_get update -q
apt_get install -y -q ca-certificates curl gnupg age unattended-upgrades \
  iptables-persistent netfilter-persistent >/dev/null
[ "$profile" = "standard" ] && apt_get install -y -q fail2ban >/dev/null

# Services of the stock image that a headless 1 GB demo VM does not use (profile micro only).
# Disable + mask is idempotent; a missing unit is skipped. Each is verified at the end.
TRIM_UNITS=(
  fwupd.service fwupd-refresh.timer fwupd-refresh.service
  multipathd.service multipathd.socket
  iscsid.service iscsid.socket open-iscsi.service
  udisks2.service ModemManager.service
  rpcbind.service rpcbind.socket
  open-vm-tools.service vgauth.service
  packagekit.service
)
if [ "$profile" = "micro" ]; then
  log "trimming unused services (disable + mask)"
  for unit in "${TRIM_UNITS[@]}"; do
    if systemctl list-unit-files "$unit" --no-legend 2>/dev/null | grep -q .; then
      systemctl disable --now "$unit" >/dev/null 2>&1 || true
      systemctl mask "$unit" >/dev/null 2>&1 || true
    fi
  done
  trim_failed=0
  for unit in "${TRIM_UNITS[@]}"; do
    state="$(systemctl is-enabled "$unit" 2>/dev/null || true)"
    active="$(systemctl is-active "$unit" 2>/dev/null || true)"
    if [ "$active" = "active" ]; then
      echo "NOT STOPPED: $unit" >&2
      trim_failed=1
    fi
    [ -z "$state" ] || [ "$state" = "masked" ] || {
      echo "NOT MASKED: $unit ($state)" >&2
      trim_failed=1
    }
  done
  [ "$trim_failed" -eq 0 ] || {
    echo "some unused services could not be trimmed (see above)" >&2
    exit 1
  }
fi

log "Docker Engine (official apt repository)"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME:-$VERSION_CODENAME} stable" \
    >/etc/apt/sources.list.d/docker.list
  apt_get update -q
  apt_get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
fi
daemon_json='{
  "log-driver": "local",
  "log-opts": { "max-size": "10m", "max-file": "5" },
  "live-restore": true
}'
if [ "$(cat /etc/docker/daemon.json 2>/dev/null)" != "$daemon_json" ]; then
  printf '%s\n' "$daemon_json" >/etc/docker/daemon.json
  systemctl restart docker
fi
systemctl enable --now docker >/dev/null

# micro (light profile): no n8n to tunnel to and Postgres is never published, so no forwarding at
# all; standard keeps "local" (a developer may tunnel to a bound-to-localhost service).
forwarding=local
[ "$profile" = "micro" ] && forwarding=no
log "SSH: keys only, no root, only $admin_user (TCP forwarding: $forwarding)"
cat >/etc/ssh/sshd_config.d/10-smartops.conf <<EOF
# SmartOps demo (phase 12): managed by host-setup.sh
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
AllowUsers $admin_user
MaxAuthTries 3
LoginGraceTime 30
X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding $forwarding
EOF
sshd -t
systemctl reload ssh

log "host firewall (iptables, before the image's REJECT rule)"
for port in 80 443; do
  if ! iptables -C INPUT -p tcp -m state --state NEW -m tcp --dport "$port" -j ACCEPT 2>/dev/null; then
    pos="$(iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" {print $1; exit}')"
    iptables -I INPUT "${pos:-1}" -p tcp -m state --state NEW -m tcp --dport "$port" -j ACCEPT
  fi
  if ! grep -q -- "--dport $port -j ACCEPT" /etc/iptables/rules.v4; then
    sed -i "0,/^-A INPUT -j REJECT/s//-A INPUT -p tcp -m state --state NEW -m tcp --dport $port -j ACCEPT\n-A INPUT -j REJECT/" \
      /etc/iptables/rules.v4
  fi
done

if [ "$profile" = "standard" ]; then
  log "fail2ban (sshd)"
  cat >/etc/fail2ban/jail.d/smartops.local <<'EOF'
[sshd]
enabled = true
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
EOF
  systemctl enable --now fail2ban >/dev/null
  systemctl restart fail2ban
else
  log "profile micro: no fail2ban (SSH is keys-only and reachable only from the Bastion subnet)"
fi

log "unattended security upgrades, automatic reboot at 04:00"
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
cat >/etc/apt/apt.conf.d/52smartops-unattended <<'EOF'
// SmartOps demo (phase 12): security updates reboot at 04:00 local time when needed; the
// containers come back by themselves and smartops-boot-check.service confirms it.
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-WithUsers "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:00";
EOF
# The daily package-list refresh and upgrade run in the small hours (local time), after the demo
# reset traffic and before the 03:30 backup and the 04:00 reboot, instead of at a random moment
# of the day (they used > 300 MB for a while on a 1 GB machine). Security updates stay on.
for timer in apt-daily:02:20 apt-daily-upgrade:02:50; do
  name="${timer%%:*}"
  at="${timer##*:}"
  install -d "/etc/systemd/system/$name.timer.d"
  cat >"/etc/systemd/system/$name.timer.d/90-smartops.conf" <<EOF
[Timer]
OnCalendar=
OnCalendar=*-*-* $at
RandomizedDelaySec=5min
Persistent=true
EOF
done
systemctl daemon-reload
systemctl restart apt-daily.timer apt-daily-upgrade.timer

log "swap (2 GB)"
if ! swapon --show=NAME --noheadings | grep -q '^/swapfile$'; then
  [ -f /swapfile ] || { fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null; }
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi
# micro: 60 = the value the 550 MiB simulation was measured with (cold pages may go to swap so
# the page cache stays); standard: 10.
swappiness=10
[ "$profile" = "micro" ] && swappiness=60
echo "vm.swappiness=$swappiness" >/etc/sysctl.d/90-smartops.conf
sysctl -q --system

log "journald capped at 500 MB"
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=500M\n' >/etc/systemd/journald.conf.d/90-smartops.conf
systemctl restart systemd-journald

log "directories"
install -d -m 700 /etc/smartops
install -d -m 750 /opt/smartops /opt/smartops/releases /opt/smartops/state /opt/smartops/backups

log "verification"
systemctl list-timers 'apt-daily*' --no-pager --no-legend | awk '{print "timer: " $0}' | cut -c1-120
sshd -T 2>/dev/null | grep -Ei '^(permitrootlogin|maxauthtries|allowtcpforwarding|passwordauthentication|allowusers) '
free -m | awk '/^Mem:/ {print "memory: " $3 " MB used, " $7 " MB available of " $2} /^Swap:/ {print "swap: " $2 " MB"}'
sysctl vm.swappiness
printf 'listening TCP ports: %s\n' "$(ss -tlnH | awk '{print $4}' | sed 's/.*://' | sort -un | tr '\n' ' ')"

log "done. Next: GHCR login, first bundle, init-secrets.sh, deploy.sh (docs/runbook.md)"
