#!/usr/bin/env bash
# One-time (and re-runnable) hardening + setup of the demo VM — Ubuntu 24.04 on OCI Ampere A1
# (phase 12, M2). Idempotent: every step checks before it changes anything.
#
#   sudo ./host-setup.sh [--admin-user ubuntu]
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
while [ $# -gt 0 ]; do
  case "$1" in
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

log "timezone"
timedatectl set-timezone America/Montevideo

log "packages"
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg age fail2ban unattended-upgrades \
  iptables-persistent netfilter-persistent >/dev/null

log "Docker Engine (official apt repository)"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME:-$VERSION_CODENAME} stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
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

log "SSH: keys only, no root, only $admin_user"
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
AllowTcpForwarding local
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

log "swap (2 GB)"
if ! swapon --show=NAME --noheadings | grep -q '^/swapfile$'; then
  [ -f /swapfile ] || { fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null; }
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi
echo 'vm.swappiness=10' >/etc/sysctl.d/90-smartops.conf
sysctl -q --system

log "journald capped at 500 MB"
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=500M\n' >/etc/systemd/journald.conf.d/90-smartops.conf
systemctl restart systemd-journald

log "directories"
install -d -m 700 /etc/smartops
install -d -m 750 /opt/smartops /opt/smartops/releases /opt/smartops/state /opt/smartops/backups

log "done. Next: GHCR login, first bundle, init-secrets.sh, deploy.sh (docs/runbook.md)"
