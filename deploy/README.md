# Deploy bundle — public demo (phase 12, ADR-023)

Everything the demo server needs, shipped **inside the API image of each version** at
`/opt/smartops-deploy` (the server extracts it with `bin/fetch-bundle.sh`; it needs only a
read-only GHCR token). The full procedure is in [`docs/runbook.md`](../docs/runbook.md).

| Path                  | What                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `compose.yaml`        | Caddy, panel, API, worker, n8n (no editor), Postgres — only Caddy publishes ports         |
| `Caddyfile`           | HTTPS, one origin (`/` panel, `/api` API), security headers, internal routes blocked      |
| `postgres-init/`      | app + n8n roles and databases (first volume creation only)                                |
| `bin/host-setup.sh`   | one-time VM hardening (SSH, iptables, fail2ban, updates + 04:00 reboot, Docker, swap)     |
| `bin/init-secrets.sh` | generates the missing secrets in `/etc/smartops/demo.env` (600), never overwrites         |
| `bin/deploy.sh`       | deploys a tagged version: backup → migrations → seed → n8n import → up → checks via Caddy |
| `bin/rollback.sh`     | previous version's images (database untouched, forward-only migrations)                   |
| `bin/backup.sh`       | encrypted dumps (age, public key only) → Object Storage (instance principal)              |
| `bin/restore-test.sh` | runs on the OWNER'S PC: decrypts with the private key, restores into a throw-away DB      |
| `bin/monitor.sh`      | every 5 min: disk, memory, containers, HTTPS → Healthchecks.io                            |
| `bin/boot-check.sh`   | after each boot: containers back + demo answering → Healthchecks.io                       |
| `bin/status.sh`       | one-screen status                                                                         |
| `bin/n8n-import.sh`   | workflows + credentials by CLI (secrets never written to the server's disk)               |
| `lib/render-n8n.mjs`  | restores the ids the workflows reference; credentials from the server's secrets           |
| `systemd/`            | backup (03:30), monitor (5 min) and boot-check units                                      |

Checked in CI by `scripts/ci/check-deploy-bundle.sh` (shellcheck, `caddy validate`, compose
invariants) and `scripts/ci/api-container-smoke.sh` (bundle inside the image).
