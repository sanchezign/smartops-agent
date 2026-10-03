# Runbook — public demo on Oracle Cloud (phase 12)

How to operate the demo server: deploy, rollback, backups, restore, secret rotation, and what to
do when something breaks. Design and decisions: ADR-023 (added when the phase closes) and
[`deploy/README.md`](../deploy/README.md). Everything runs **on the VM with `sudo`**, except the
restore test, which runs **on your computer**.

> Status: M0 (scripts tested locally with `scripts/deploy/local-harness.sh`). The Oracle console
> (M1), hardening (M2) and first start (M3) sections are completed with each milestone's
> step-by-step guide.

## 0. What is on the VM

| Path                          | What it is                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `/etc/smartops/demo.env`      | secrets + domain (root, **600**). Created by `init-secrets.sh`; never uploaded |
| `/etc/smartops/backup.env`    | backup target, your **public** age key, Healthchecks URL (600)                 |
| `/etc/smartops/monitor.env`   | Healthchecks URLs and disk / memory thresholds (600)                           |
| `/opt/smartops/releases/<v>/` | the bundle of each version (taken from its API image)                          |
| `/opt/smartops/current`       | link to the version in use (the systemd timers follow it)                      |
| `/opt/smartops/state/`        | `current`, `previous`, `deploy.log`                                            |
| `/opt/smartops/backups/`      | local encrypted copies (7 days)                                                |

Two profiles (`DEMO_PROFILE` in `demo.env`, chosen once with `init-secrets.sh --profile`):

- **light** (the Oracle E2.1.Micro, 1 GB; ADR-025): `caddy` (the only one with ports: 80/443),
  `admin`, `api` (API + worker + the orchestrator that plays the n8n workflows, one process,
  samples one at a time) and `postgres`. No n8n. `compose.light.yaml`.
- **full** (a bigger server): `caddy`, `admin`, `api`, `worker`, `n8n` (no editor), `postgres`.
  `compose.yaml`.

The sections below say "(full only)" where a step does not exist in the light profile. Status at a
glance:

```bash
sudo /opt/smartops/current/bin/status.sh
```

## 1. Deploying a version

Versions are the GitHub tags (`v0.12.0` → image `0.12.0`). The VM **pulls** the version; nobody
pushes anything to the VM and CI has no credentials for it.

```bash
sudo /opt/smartops/current/bin/deploy.sh 0.13.0
```

What it does, in order (if a step fails, it stops with a clear message and the previous version
keeps running):

1. fetches the bundle of `0.13.0` from its image (if missing) and hands over to **its**
   `deploy.sh`;
2. checks that `demo.env` is 600 and holds **no real key** (the API also refuses to start if it
   finds one);
3. pulls the images;
4. makes an **encrypted backup before migrating** (not on the first install);
5. runs `prisma migrate deploy` (forward only);
6. re-seeds the demo data (users and sessions are kept);
7. imports and publishes the n8n workflows from the command line (full only);
8. starts everything, waits for the health checks and tests `https://<domain>/api/v1/health` and
   `/login` through Caddy;
9. records `current` / `previous` and updates the timers.

## 2. Rollback

```bash
sudo /opt/smartops/current/bin/rollback.sh          # back to the previous version
sudo /opt/smartops/current/bin/rollback.sh 0.12.0   # or to a given version
```

It rolls back the **images**, the compose file and the n8n workflows; **the database is not
touched**. Project rule: migrations are _expand/contract_ (a migration never breaks the previous
version). If the database has migrations the target version does not know, the rollback
**refuses** and lists them:

- if they are additive (new columns / tables): `rollback.sh 0.12.0 --accept-newer-schema`;
- if not: restore the `pre-deploy-<version>` backup (section 5), then roll back.

## 3. Backups

Daily at 03:30 (Montevideo time) and before every deploy: the databases (demo, and n8n in the
full profile) and `demo.env` (without it, the credentials stored in n8n cannot be read), **encrypted with age to
your public key**. The private key lives only on your computer: whoever takes the VM cannot read
the backups.

`/etc/smartops/backup.env` (600):

```ini
BACKUP_AGE_RECIPIENT=age1…          # your PUBLIC key (age-keygen -y key.txt)
BACKUP_TARGET=oci
OCI_BUCKET=smartops-backups         # retention: the bucket's lifecycle policy (30 days)
HC_BACKUP_URL=https://hc-ping.com/… # optional: Healthchecks warns if a backup fails or never arrives
```

By hand: `sudo /opt/smartops/current/bin/backup.sh --reason manual`.

## 4. Restore test (on your computer, once a month)

1. Download one backup folder from the bucket (Object Storage → bucket → folder
   `<date>-<reason>/` → download the 4 files).
2. In the repository:

```bash
deploy/bin/restore-test.sh --dir <downloaded folder> --identity <your age key> \
  --hc-url https://hc-ping.com/<uuid of the monthly check>
```

It verifies the checksums, decrypts in memory, restores into a **throw-away** Postgres, counts
rows (migrations, users, products, messages; n8n workflows and credentials in the full profile) and removes the
container. The monthly Healthchecks.io check (period 30 days) emails you only if a month passes
without a successful restore: that is the reminder (there is no timer on the VM).

## 5. Real restore (the database or the VM was lost)

1. A new VM (runbook M1/M2) or the same VM.
2. On your computer, decrypt `demo.env.age` from the backup and copy the result to the VM as
   `/etc/smartops/demo.env` (root, `chmod 600`). **It must be the same file**: the
   `N8N_ENCRYPTION_KEY` of that backup is the one that reads the n8n credentials.
3. Deploy the **same version** as the backup (`manifest.txt` → `version=`):
   `sudo /opt/smartops/releases/<v>/bin/deploy.sh <v> --skip-backup`.
4. Restore the databases (decrypt on your computer and upload the `.dump` files to the VM through
   the tunnel):

```bash
# light profile: stop api, restore only smartops_demo; full profile: stop api worker n8n
sudo docker compose -p smartops-demo stop api worker n8n
for db in smartops_demo n8n; do
  sudo docker compose -p smartops-demo exec -T postgres \
    pg_restore -U postgres --clean --if-exists --no-owner -d "$db" < "$db.dump"
done
sudo docker compose -p smartops-demo start api worker n8n
sudo /opt/smartops/current/bin/status.sh
```

5. Delete the decrypted `.dump` files from the VM and from your computer.

## 6. Rotating secrets

| Secret                                                           | How                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GHCR token (classic PAT, `read:packages`, expires after 90 days) | Create a new one on GitHub → `sudo docker login ghcr.io -u <user>` (paste it on stdin) → revoke the old one. **Current token: created 2026-10-02, expires 2026-12-31 — renew by 2026-12-15.** Reminder: a Healthchecks check with an 85-day period that you ping after each rotation (section 11) |
| `INTERNAL_API_KEY`, `N8N_WEBHOOK_SECRET`                         | delete the line from `demo.env`, `sudo init-secrets.sh` generates a new one, then `deploy.sh <current version>` (re-imports the n8n credentials)                                                                                                                                                  |
| `JWT_ACCESS_SECRET`                                              | the same; visitors sign in again (expected)                                                                                                                                                                                                                                                       |
| Postgres passwords                                               | `ALTER ROLE … PASSWORD` inside the container, update `demo.env`, `deploy.sh <current version>`                                                                                                                                                                                                    |
| `N8N_ENCRYPTION_KEY`                                             | **not rotated** without re-encrypting the n8n credentials; on the demo it is enough to delete the n8n volume and deploy (they are re-imported)                                                                                                                                                    |
| age key                                                          | a new key on your computer, a new `BACKUP_AGE_RECIPIENT`; keep the old one while backups encrypted with it exist (30 days)                                                                                                                                                                        |

Never paste a secret into a command (it stays in the shell history): use 600 files or stdin.

## 7. When something breaks

| Symptom                                | What to do                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Healthchecks "monitor" email (fail)    | `status.sh`; the alert text says what failed (disk, memory, container, HTTPS)                                      |
| Healthchecks without pings             | the VM is down or stopped: OCI console → the instance → _Reboot_; then `status.sh`                                 |
| "boot" email (fail) after 04:00        | the containers did not come back on their own: `sudo docker compose -p smartops-demo up -d` and check the `logs`   |
| UptimeRobot: the demo does not answer  | `status.sh`; `sudo docker compose -p smartops-demo logs --tail 100 caddy api`                                      |
| Disk full                              | `sudo docker system df`; logs already rotate; delete old local backups or unused images (`docker image prune`)     |
| Oracle reclaimed / deleted the VM      | section 5 with a new VM (the backup is in Object Storage)                                                          |
| "Out of capacity" when creating the VM | retry at another time or with a smaller shape; there is no other availability domain in the region                 |
| OCI budget alert                       | **should never happen** (account not upgraded): console → Billing → Cost Analysis, find the resource and delete it |

## 8. Testing locally before a release

```bash
docker build -f apps/api/Dockerfile   -t smartops-local/smartops-api:m0a .
docker build -f apps/admin/Dockerfile -t smartops-local/smartops-admin:m0a .
docker tag smartops-local/smartops-api:m0a smartops-local/smartops-api:m0b
docker tag smartops-local/smartops-admin:m0a smartops-local/smartops-admin:m0b
scripts/deploy/local-harness.sh <empty folder>
```

`HARNESS_PROFILE=light` tests the 1 GB profile; `HARNESS_PROJECT=<name>` isolates a run.
It runs the real `deploy/bin` scripts against your Docker (ports on 127.0.0.1 only): deploy, a
smoke test through Caddy (headers, blocked internal routes, SSE, a sample through n8n or the
orchestrator), a second
deploy with a backup, the restore test, a rollback and the refusal on a newer schema. At the end
it prints the commands to tear it down (it does not run them).

## 9. Access through Bastion when your home IP changes

The VM has no open SSH port: you reach it through an OCI Bastion **port forwarding** session
(`smartopsbastion`). The bastion only accepts connections from its **CIDR allowlist** (your home
IP as a `/32`). When your IP changes the connection fails; update the list. Changes apply to NEW
sessions only. Oracle's guidance: keep the range as small as possible and **never `0.0.0.0/0`**.

**Manual procedure (works from a phone)**

1. Find your public IP (any "what is my IP" page).
2. Console → _Identity & Security_ → _Bastion_ → `smartopsbastion` → _Edit_ → _CIDR block
   allowlist_ → replace the address with `<your-ip>/32` → _Save changes_.
3. Create a new port forwarding session (target: the VM's private IP `10.0.0.21`, port 22) with a
   **new ephemeral key pair for each session**; the maximum session time is 3 hours.
4. Connect with the command the console shows for that session.

The same from a terminal with the OCI CLI (flags checked in Oracle's CLI reference):

```bash
oci bastion bastion update --bastion-id <bastion-ocid> --client-cidr-list '["<your-ip>/32"]' --force
oci bastion session create-port-forwarding --bastion-id <bastion-ocid>   --target-private-ip 10.0.0.21 --target-port 22 --ssh-public-key-file <new-key>.pub   --session-ttl 10800 --wait-for-state SUCCEEDED
```

An on-demand script that does this with a least-privilege IAM user (API key with its own
passphrase) is planned (phase 12, M3b); this manual procedure stays as the fallback.

## 10. Oracle's idle policy (Always Free VMs)

Oracle may reclaim a VM that is idle for 7 days: CPU p95 under 20 % **and** network under 20 %
(the memory criterion is for A1 only). A reclaimed VM is **stopped**, not deleted, according to
third-party reports; to start it again its shape must be available and a free account cannot open
support requests. What to do: the Healthchecks alert arrives (no pings) → start it from the console
or the CLI (section 7). We never create artificial load. How "CPU utilization" is computed for a
1/8-OCPU shape is not documented: it is calibrated on the real VM by comparing the `CpuUtilization`
metric (Oracle Cloud Agent, Compute Instance Monitoring plugin) with the CPU time of a demo reset.

## 11. Connection tips and reminders

- **SSH through the Bastion** drops on long sessions ("client_loop: send disconnect: Connection
  reset"). Always pass `-o ServerAliveInterval=30` (and `-o ServerAliveCountMax=4` on the
  tunnel); the same for `scp`: `scp -o ServerAliveInterval=30 …`.
- **GHCR token expiry:** created 2026-10-02 with 90 days → **expires 2026-12-31**. Renew by
  2026-12-15 (section 6). To not depend on memory, create a Healthchecks.io check "ghcr-token" with
  a period of 85 days and a grace of 5 days, and ping its URL (`curl -fsS <url>`) every time you
  rotate the token: if you forget, it emails you.
- **Automatic updates run at 02:20 and 02:50** (local time; the timers are validated by a test with
  `systemd-analyze calendar`). Check on the VM: `systemctl list-timers 'apt-daily*'`; an invalid
  timer would show `Failed to parse calendar specification` in `journalctl -u apt-daily.timer`.
