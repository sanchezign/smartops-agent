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
| `/etc/smartops/keepalive.env` | the keep-alive load switch: `KEEPALIVE_LOAD=on                                 | off`, minutes (644, no secrets) |
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

### Checking a deployed version (from your computer, after every deploy)

```bash
node scripts/deploy/demo-check.mjs https://smartops-demo.duckdns.org            # English content (default)
node scripts/deploy/demo-check.mjs https://… --content=es                        # a deployment seeded in Spanish
node scripts/deploy/demo-abuse-check.mjs https://… --skip-login-limit           # bounded abuse / load check
```

`demo-check` signs in as the public operator (`demo@smartops.test`, the one the login screen shows),
checks the edge (health, TLS, HSTS, internal and webhook routes answer 404), that the seeded
suppliers are those of `DEMO_CONTENT_LANGUAGE`, that the event stream sends its first frame at once,
and sends the six "Try the system" samples one by one. Expected final states: `foto`, `pdf`, `audio`
and `planilla` end as `ingested`; `planilla_nueva` (a new spreadsheet format) and `injection` end as
`needs_review`. Typical times are 4–8 s each (the light profile runs them one at a time). It exits 0
only if every line says `ok`. Against `http://127.0.0.1:<port>` (a local DEMO_MODE API) the checks that
need Caddy are skipped. `demo-abuse-check` has side effects (your IP waits up to a minute; the login
limit step locks your IP out for up to 15 minutes): see the header of the script.

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
OCI_NAMESPACE=…                     # tenancy namespace (printed by scripts/oci/setup-backup-bucket.ps1)
HC_BACKUP_URL=https://hc-ping.com/… # optional: Healthchecks warns if a backup fails or never arrives
```

The VM may only **create** objects in the bucket (instance principal, append-only policy): it cannot
overwrite, delete or read a backup, and Oracle's lifecycle rule removes them after 30 days. Setup,
the policy and its proof (`backup-selftest.sh`): [backups guide](deploy/backups.md), ADR-026.

By hand: `sudo /opt/smartops/current/bin/backup.sh --reason manual`. The last log line (and the
Healthchecks body) says the lowest available memory during the run.

## 4. Restore test (on your computer, once a month)

1. Download one backup folder from the bucket in the web console (the files of
   `<date>-<reason>/`, see the backups guide).
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

| Secret                                                           | How                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GHCR token (classic PAT, `read:packages`, expires after 90 days) | Create a new one on GitHub → `sudo docker login ghcr.io -u <user>` (paste it on stdin) → revoke the old one. **Current token: created 2026-10-02, expires 2026-12-31 — renew by 2026-12-15.** Reminder: a Healthchecks check with a 60-day period and 5 days of grace that you ping after each rotation (section 11; 85 days would only warn on the expiry day) |
| `INTERNAL_API_KEY`, `N8N_WEBHOOK_SECRET`                         | delete the line from `demo.env`, `sudo init-secrets.sh` generates a new one, then `deploy.sh <current version>` (re-imports the n8n credentials)                                                                                                                                                                                                                |
| `JWT_ACCESS_SECRET`                                              | the same; visitors sign in again (expected)                                                                                                                                                                                                                                                                                                                     |
| Postgres passwords                                               | `ALTER ROLE … PASSWORD` inside the container, update `demo.env`, `deploy.sh <current version>`                                                                                                                                                                                                                                                                  |
| `N8N_ENCRYPTION_KEY`                                             | **not rotated** without re-encrypting the n8n credentials; on the demo it is enough to delete the n8n volume and deploy (they are re-imported)                                                                                                                                                                                                                  |
| age key                                                          | a new key on your computer, a new `BACKUP_AGE_RECIPIENT`; keep the old one while backups encrypted with it exist (30 days)                                                                                                                                                                                                                                      |

Never paste a secret into a command (it stays in the shell history): use 600 files or stdin.

## 7. When something breaks

Setting up the checks and proving the alerts: [monitoring guide](deploy/monitoring.md).

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

The same, in one command, with a least-privilege IAM user (API key with its own passphrase):
[`scripts/oci/bastion-connect.ps1`](../scripts/oci/bastion-connect.ps1), set up in
[`docs/deploy/bastion-access.md`](deploy/bastion-access.md). This manual procedure stays as the
fallback.

## 10. Oracle's idle policy (Always Free VMs)

**The rule.** Oracle's documentation says an idle Always Free VM "may be reclaimed": idle = during 7 days CPU
p95 under 20 %, network under 20 % (and memory under 20 % for A1 only). Sources:
[Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).
It does **not** say what happens to the instance, whether you are warned, whether it applies during the Free
Trial, or on what granularity the p95 is computed. Third-party reports of Oracle's own e-mail
([51sec.org](https://blog.51sec.org/2023/02/oracle-cloud-cleaning-up-idle-compute.html)) say: one week's notice,
the instance is **stopped, not deleted**, and it can be started again "as long as the associated compute shape
is available". The thresholds have changed over time (10 %, 15 %, now 20 %).

**What we measured** (2026-10-04, [cpu-calibration.md](deploy/cpu-calibration.md)): the `CpuUtilization` metric is
the guest's busy% plus steal (not scaled to the 1/8 OCPU); the quiet demo runs at about 3 % (p95 5 %), a normal
day's p95 is 6–8 % and the busiest day measured 13 %. **The demo alone meets the literal criterion for idle.**

**Decision (the owner, 2026-10-04).** Until now this runbook said "we never create artificial load". That rule
is replaced: a nightly keep-alive load is allowed because losing the public demo to a reclaim costs more than two
hours of a harmless process, and no official source forbids it. It is the lowest-priority, no-network, no-disk
process of [ADR-027](adr/ADR-027-keepalive-load.md), **off by default**, trial and activation in
[keepalive.md](deploy/keepalive.md). Switch it off at once with `sudo /opt/smartops/current/bin/keepalive.sh off`
if Oracle ever forbids artificial load or it hurts the demo.

**Plan B (applies with the load on or off).** If Oracle stops the VM (its e-mail, an UptimeRobot alert or no
Healthchecks pings): Console → Compute → Instances → `smartops-demo-micro` → _Start_ (retry later if there is no
capacity); wait about 3 minutes; verify that the health URL answers 200, the reserved IP is still attached,
`status.sh` shows the containers healthy and the timers, `keepalive.sh status`, and `demo-check.mjs` passes; the
monitors turn green by themselves. If the instance was terminated instead, section 5 (the backups are in Object
Storage). Afterwards read the `CpuUtilization` p95 of the last 7 days: if the load was on and Oracle stopped the VM
anyway, the policy is measuring something else; do not change anything before looking at the numbers. The full
checklist is in [keepalive.md](deploy/keepalive.md), section 4.

## 11. Connection tips and reminders

- **SSH through the Bastion** drops on long sessions ("client_loop: send disconnect: Connection
  reset"). Always pass `-o ServerAliveInterval=30` (and `-o ServerAliveCountMax=4` on the
  tunnel); the same for `scp`: `scp -o ServerAliveInterval=30 …`.
- **GHCR token expiry:** created 2026-10-02 with 90 days → **expires 2026-12-31**. Renew by
  2026-12-15 (section 6). To not depend on memory, create a Healthchecks.io check "ghcr-token" with
  a period of 60 days and a grace of 5 days (the email then arrives about 65 days after the last
  ping, well before the 90-day expiry), and ping its URL (`curl -fsS <url>`) every time you
  rotate the token: if you forget, it emails you.
- **Automatic updates verified on the real VM (2026-10-03):** the night's security updates and the 04:00
  reboot ran (kernel 6.17.0-1020 → 7.0.0-1012; pending updates went from 39, 28 of them security, to 15
  with none of security) and the demo came back by itself after the reboot.
- **Automatic updates run at 02:20 and 02:50** (local time; the timers are validated by a test with
  `systemd-analyze calendar`). Check on the VM: `systemctl list-timers 'apt-daily*'`; an invalid
  timer would show `Failed to parse calendar specification` in `journalctl -u apt-daily.timer`.

## 12. Before the Oracle Free Trial ends (checklist, by 2026-10-28)

The account was created on about 2026-09-28 with the Free Trial: "$300 of cloud credits valid for up to 30 days"
([Free Tier](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm)), so it ends around **2026-10-28**
(the Console shows the exact date, step 1). What Oracle says happens then:

> Paid resources provisioned with credits during the free trial "are reclaimed by Oracle unless you upgrade your
> account"; Always Free resources "continue to be available with no interruption" and the account stays active
> ([Free Tier](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm)).

So the whole question is: **is every resource of the project Always Free?** Do **not** click _Upgrade_: Pay As You
Go was discarded (ADR-023: a US$100 hold, no capacity guarantee) and the rule of the project is $0. Each statement
below has its source; **"not confirmed"** means I found no statement in Oracle's documentation (read 2026-10-06).

### 12.1 Inventory (everything the project has in OCI)

Home region São Paulo (`sa-saopaulo-1`), compartment `smartops`. Limits come from
[Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
(called _AF_ below) unless another link is given.

**1. VM `smartops-demo-micro`, shape `VM.Standard.E2.1.Micro`** — Always Free: **yes** (AF). Limit: "up to two Always
Free VM instances using the VM.Standard.E2.1.Micro shape" (1/8 OCPU, 1 GB); we use 1. After the trial: continues (Free
Tier page). The only risk is the idle-reclaim rule (§10, ADR-027).

**2. Boot volume of the VM (about 47–50 GB)** — Always Free: **yes** (AF). Limit: "200 GB of Always Free block volume
storage" for boot and block volumes together; "the minimum boot volume size for each instance is 47 GB". After the
trial: continues.

**3. Volume backups (boot or block)** — Always Free: yes, up to five (AF: "a maximum of five Always Free volume backups
at any time"); **the project has none** (its backups are in Object Storage, item 6). Check there are none (step 4).

**4. VCN `smartops-vcn` (10.0.0.0/16), internet gateway `smartops-igw`, route table, security list, subnet
`smartops-public`** — VCN: **yes** (AF: "Free Tier tenancies … can have up to 2 virtual cloud networks"; we use 1).
Gateway, route table, security list and subnet: **not confirmed** (no separate price or limit in the pages read).
Outbound data: "10 TB per month" (AF); the demo moves a few MB. After the trial: the VCN continues; for the rest the
Cost Analysis of step 1 shows any charge.

**5. Reserved public IP (the one in DuckDNS), attached to the VM's private IP** — Always Free: **not confirmed**. The
[Public IPs page](https://docs.oracle.com/en-us/iaas/Content/Network/Tasks/managingpublicIPs.htm) says "You can create
50 per region" and that it exists "until you delete it", and says **nothing** about cost; it is not in the Always Free
list. A third-party source mentions a monthly price when it is **unattached**: unverified. **This is the main risk**:
if Oracle treated it as a paid resource it could be reclaimed when the trial ends, and the VM would lose the address
DuckDNS points to (recovery: 12.3). The fallback is free, though: the Always Free page of the shape says the
VM.Standard.E2.1.Micro "Includes one **VNIC** with one public IP address"
([Details of the Always Free compute instances](https://docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm)),
so an **ephemeral** public IP on that VNIC costs nothing: the loss is only that the address changes, and DuckDNS must
be updated. Keep the reserved IP attached (step 3).

**6. Object Storage bucket `smartops-backups` (private, Standard, no versioning) + lifecycle rule `expire-backups`
(delete after 30 days)** — Always Free: **yes, with a different limit before and after** (AF). During the trial: "10 GB
of Standard tier data" (plus 10 GB Infrequent Access and 10 GB Archive) and "50,000 Object Storage API requests per
month". After it ("Always Free only accounts"): "20 GB of combined Standard tier, Infrequent Access tier, and Archive
tier data" and the same 50,000 requests. The lifecycle rule has no separate price in the pages read: not confirmed.
**Danger:** "If you are using more than the 20-GB limit when your Free Trial ends, all of your objects will be
deleted." Keep the bucket far under 10 GB (step 5).

**7. Bastion `smartopsbastion` (port-forwarding sessions, TTL up to 3 h)** — Always Free: **yes**: "Bastion is free for
both free and paid accounts" (AF). After the trial: continues.

**8. IAM in the Default identity domain: users `smartops-bastion` and your own admin, group
`smartops-bastion-users`, dynamic group `smartops-vm` (`instance.id` = the VM), policies `smartops-bastion-policy` and
`smartops-backups`, compartment `smartops`** — Always Free: **yes**, every tenancy gets a "Free" identity domain
([domain types](https://docs.oracle.com/en-us/iaas/Content/Identity/sku/overview.htm)). Limits of the Free type: 2,000
users, 250 groups, **50 dynamic groups**; it supports "All current Infrastructure as a Service IAM features" and
"Dynamic groups (for OCI)" (we use 1 dynamic group, 2 users, 1 group). What happens to the domain after the trial:
**not confirmed** (the page does not say). Check step 8.

**9. Monitoring: the project only reads the VM's `CpuUtilization`** (Metrics Explorer, namespace `oci_computeagent`);
no alarms and no Notifications topics (the monitors are UptimeRobot and Healthchecks.io) — Always Free: **yes** (AF:
"500 million Monitoring service ingestion data points, and 1 billion retrieval data points"; Notifications, unused:
"1 million https notifications per month, and 1000 email notifications per month"). After the trial: continues. Check
step 9 that no alarm or topic exists by accident.

**10. Budget `smartops-cero-gasto` (US$1, 2 alert rules)** — Cost of the budget: **not confirmed** (the
[budgets page](https://docs.oracle.com/en-us/iaas/Content/Billing/Concepts/budgetsoverview.htm) gives no price). It
says "Use budgets to set soft limits": it stops nothing, it only e-mails, and "all budget alerts are evaluated
periodically every 24 hours". It keeps working after the trial and is the early warning that something started to cost.

**11. Resource Manager stack `smartops-demo-vm`** (a record of the A1 launch attempt; it holds no resources) — Always
Free: **yes** (AF: "Stacks: 100", "Jobs (concurrent): 2"). It stays on purpose; the A1 retry is on hold
(`scripts/oci/launch-retry.ps1`). To keep Arm instances an Always Free account may have at most "2 OCPUs and 12 GB of
memory" in total (Free Tier page).

**12. Oracle Cloud Agent on the VM (Compute Instance Monitoring plugin)** — Always Free: **not confirmed** as a separate
item (it is part of the VM image; no price found). Continues with the VM.

### 12.2 The Console checklist (do it before 2026-10-28, and again on 2026-10-29)

Menu names can differ a little between Console versions; the goal of each step is what matters.

1. **Billing & Cost Management → Cost Analysis**, last 30 days, group by _Service_: every service must show **$0**
   (credits are shown separately). Write down the trial's end date and the credits left: the banner at the top of the
   Console says it (the _Upgrade_ link is in that banner: **do not use it**).
2. **Compute → Instances**: exactly one instance, shape `VM.Standard.E2.1.Micro`, state Running (item 1). Open its
   _Boot volume_: size ≤ 200 GB (item 2).
3. **Networking → IP management → Reserved public IPs**: exactly one, **assigned** (to the VM's private IP) and equal
   to the address in DuckDNS. Write it down (item 5). If it shows as unassigned, assign it again at once.
4. **Storage → Block Storage → Boot Volume Backups** and **Block Volume Backups**: none (item 3).
5. **Storage → Object Storage → Buckets → `smartops-backups`**: _Approximate size_ and object count. It must be
   **well under 10 GB**. Expected today: about **750 KB per backup**, kept 30 days, so **tens of MB** in total (about 30 nightly backups plus the
   pre-deploy ones: 20–40 MB): if it shows hundreds of MB or more, something is
   wrong. To see it: open the bucket (the _Details_ tab shows _Approximate size_ and _Object count_; the figures can lag
   by a few hours) or _Objects_ to read each file's size. Lifecycle rule `expire-backups` _Enabled_, 30 days. If the size is anywhere near 10 GB, delete
   the oldest objects by hand **before** the trial ends (item 6: above 20 GB everything is deleted). The bucket's
   _Metrics_ show the requests; the limit is 50,000 a month.
6. **Identity & Security → Bastion**: one bastion `smartopsbastion`, Active (item 7). Run `bastion-connect.ps1` once.
7. **Governance & Administration → Budgets**: `smartops-cero-gasto` with its 2 alert rules (item 10).
8. **Identity & Security → Domains → Default**: the type is _Free_; Users: your admin and `smartops-bastion` only
   (`smartops-launcher` was removed); Groups: `smartops-bastion-users`; Dynamic groups: `smartops-vm`; and in
   **Policies**: `smartops-bastion-policy` and `smartops-backups` (item 8). Anything else is not from this project.
9. **Observability & Management → Monitoring → Alarm definitions** and **Developer Services → Notifications →
   Topics**: nothing from this project (item 9).
10. **Developer Services → Resource Manager → Stacks**: `smartops-demo-vm`, with no resources (item 11).
11. **On the VM**: `sudo /opt/smartops/current/bin/status.sh` (containers healthy, timers), the backup of last night
    (§3), `free -m`.
12. **From your PC**: `node C:\dev\demo-check.mjs https://smartops-demo.duckdns.org`.

**The day after the trial ends (2026-10-29)**: repeat 1, 2, 3, 5 and 12, and read your e-mail for anything from
Oracle. The bucket must still hold its objects (item 6); the VM must be Running with the same IP; Cost Analysis must
still be $0.

### 12.3 If something was reclaimed or stopped

- **The reserved IP is gone** (the VM is up, DuckDNS points nowhere). The cheapest fix, and free, is an **ephemeral**
  public IP: the shape "Includes one VNIC with one public IP address"
  ([Oracle](https://docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm)). Compute → Instances → the VM →
  _Attached VNICs_ → the VNIC → _IPv4 addresses_ → the primary private IP → _Edit_ → public IP type _Ephemeral public
  IP_ (if the old reserved IP is still listed, remove it first). Then update the address in DuckDNS, wait for the DNS
  TTL (Caddy asks Let's Encrypt for a new certificate by itself when the name answers again), and run `status.sh` and
  `demo-check`.
- **The VM was stopped**: plan B of §10 (_Start_ from the Console, verify, restore from the backup if needed).
- **The backups were deleted**: the bucket is empty; the next nightly backup recreates the first one. A copy on your PC
  exists only if you did the monthly restore test (§4): do one before the trial ends.
- Anything that shows a charge in Cost Analysis: tell me the service and the amount before touching anything.
