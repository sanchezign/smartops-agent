# Backups to Object Storage, step by step (phase 12, M5)

Goal: every night (and before every deploy) the VM sends **encrypted** dumps to a private Object
Storage bucket, and a thief with root on the VM can neither read nor destroy them. Design and
measurements: [ADR-026](../adr/ADR-026-append-only-backups.md).

| Who holds what              | Can do                                                          |
| --------------------------- | --------------------------------------------------------------- |
| Your PC (age private key)   | decrypt backups (restore tests happen here)                     |
| The VM (instance principal) | **create** and list objects in `smartops-backups`; nothing else |
| Oracle (lifecycle rule)     | delete objects older than 30 days                               |

Everything is still free: 20 GB and 50,000 requests a month are in the Always Free allowance, and
a backup is a few hundred KiB.

## 1. Your age key pair (your PC)

The private key is created **on your PC and never leaves it**. Pick one way:

```bash
# a) age installed (https://github.com/FiloSottile/age/releases)
age-keygen -o smartops-backup-key.txt

# b) no install: a throw-away container (the same age the server uses)
docker run --rm -v "$PWD:/k" alpine:3.24.2 sh -c "apk add -q --no-cache age && age-keygen -o /k/smartops-backup-key.txt"
```

It prints `Public key: age1…`. Show it again any time with `age-keygen -y smartops-backup-key.txt`.

- Copy `smartops-backup-key.txt` to your password manager **and** one offline place (a USB stick).
  Without it the backups are unreadable, and nobody (including me) can recover it.
- Never copy it to the VM, the repository or a chat. Only the `age1…` line travels.

## 2. The bucket, group and policy (Oracle web console, no admin API key)

You do **not** need an administrator API key on your PC: everything below is done in the web
console, signed in as yourself. (OCI Cloud Shell would also work, but it has no PowerShell, so it
could not run `setup-backup-bucket.ps1`; see "Alternative" at the end of this step.)

Get two values first:

- the VM's OCID: Compute → Instances → `smartops-demo-micro` → OCID → _Copy_;
- the **namespace**: Storage → Buckets, shown at the top of the page (a short string). It becomes
  `OCI_NAMESPACE`.

Do the four parts **in this order** (the lifecycle rule needs the policy):

**a) Dynamic group** — Identity & Security → Domains → `Default` → Dynamic groups → _Create dynamic
group_. Name `smartops-vm` (it cannot be changed later), description "SmartOps demo VM", matching
rule (type it, replacing the OCID; Oracle does not verify OCIDs, so check it twice):

```text
instance.id = 'ocid1.instance.oc1.sa-saopaulo-1.xxxx'
```

**b) Policy** — Identity & Security → Policies → _Create policy_, **in the root compartment**
(the tenancy), name `smartops-backups`, description "SmartOps demo: append-only backups". In the
policy builder switch to the manual editor and paste exactly these three statements (one per line;
the region in the last one is yours if it is not São Paulo):

```text
Allow dynamic-group 'Default'/'smartops-vm' to read buckets in compartment smartops where target.bucket.name = 'smartops-backups'
Allow dynamic-group 'Default'/'smartops-vm' to manage objects in compartment smartops where all {target.bucket.name = 'smartops-backups', any {request.permission = 'OBJECT_CREATE', request.permission = 'OBJECT_INSPECT'}}
Allow service objectstorage-sa-saopaulo-1 to manage object-family in compartment smartops where any {request.permission = 'BUCKET_INSPECT', request.permission = 'BUCKET_READ', request.permission = 'OBJECT_INSPECT', request.permission = 'OBJECT_DELETE', request.permission = 'OBJECT_VERSION_DELETE'}
```

What they say: the VM may read that one bucket's metadata and **create / inspect** objects in it, and
nothing else (no overwrite, delete or read). The third one lets the Object Storage _service_ delete
expired objects for the lifecycle rule. If the console shows your identity domain with another
name (Identity → Domains), use that name instead of `Default` in the first two.

**c) Bucket** — Storage → Buckets → _Create bucket_, compartment `smartops`, name
`smartops-backups`, tier **Standard**, **no** auto-tiering, **no** object versioning, no events,
Oracle-managed encryption (the default), visibility private (the default; never public).

**d) Lifecycle rule** — open the bucket → _Lifecycle policy rules_ (called _Policies_ in some console
versions) → _Create rule_: name `expire-backups`, target **all objects in the bucket**, action
**Delete**, **30 days**, enabled. Oracle applies rules within 10 minutes of each trigger (up to about
a day for the first pass). The console may warn that it needs a policy: that is statement 3 above,
already created in part b.

Check it: the bucket page must say Visibility _Private_, and Identity → Policies →
`smartops-backups` must list exactly those three statements.

**Alternative (an administrator profile in the OCI CLI):**
`scripts\oci\setup-backup-bucket.ps1` does all four parts, idempotently, and prints the same
statements. Look at the plan with `-DryRun` first:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\oci\setup-backup-bucket.ps1 `
  -CompartmentId ocid1.compartment.oc1..xxxx -InstanceId ocid1.instance.oc1.sa-saopaulo-1.xxxx -DryRun
```

## 3. Configure the VM (through Bastion)

Connect with `scripts\oci\bastion-connect.ps1` ([guide](bastion-access.md)). On the VM:

```bash
sudo nano /etc/smartops/backup.env      # create it if it is missing, then: sudo chmod 600 /etc/smartops/backup.env
```

```ini
BACKUP_AGE_RECIPIENT=age1…                 # the PUBLIC line from step 1
BACKUP_TARGET=oci
OCI_BUCKET=smartops-backups
OCI_NAMESPACE=<from step 2>
HC_BACKUP_URL=                             # Healthchecks.io ping URL; left empty until M6
```

The VM runs the scripts of the **released** version. M5 ships in 0.13.0: until the user deploys it,
`/opt/smartops/current/bin/backup.sh` is the older script and its `oci` branch is **broken** (it could
not read its own files). Keep `BACKUP_TARGET=none` until the VM runs 0.13.0 or later, then switch.

Pull the uploader image once, so the first backup does not wait on it:

```bash
sudo docker pull ghcr.io/oracle/oci-cli:20260923@sha256:8732a1bb9ceaca5d84cedb9cb5c6020817497291280ffa9f292d7e9950a76485
```

## 4. Prove the policy from the VM

Oracle says a change to a dynamic group can take about an hour to apply. If step 4 or 5 is refused
with `NotAuthorizedOrNotFound`, wait and repeat before touching anything.

```bash
sudo /opt/smartops/current/bin/backup-selftest.sh
```

Expected: `PASS` for creating and listing; `PASS … the object did not change` after writing the same
name again with `--no-overwrite` (the CLI skips it by itself and exits 0, so the script compares the
object's etag and size instead of trusting the exit code); `PASS … -> refused` for overwriting with
`--force` (this one proves the policy), deleting, reading back and deleting the bucket; a final
`the object did not change`; then `SELFTEST PASSED`. It leaves one
tiny object under `selftest/` that the lifecycle rule removes in 30 days. Any `FAIL` line says which
rule is too wide or too narrow; send me the output.

## 5. A real backup

```bash
sudo /opt/smartops/current/bin/backup.sh --reason manual
```

The last log line says `ok (… ; lowest available memory during the backup: N MB)`. Keep an eye on
that number: the VM has about 268 MiB free with the demo running, and the pipeline needs roughly 100.

Check in the Console (Storage → Buckets → `smartops-backups`) that a folder
`<UTC stamp>-manual/` has `smartops_demo.dump.age`, `demo.env.age` and `manifest.txt`.

## 6. Restore test on your PC

Download the three files of that folder from the web console, signed in as yourself (the VM could
not do this, you can): Storage → Buckets → `smartops-backups` → Objects → the folder
`<UTC stamp>-manual/` → for each of `smartops_demo.dump.age`, `demo.env.age` and `manifest.txt`,
_⋮ → Download_. Put them together in `C:\restore-test\<UTC stamp>-manual\`.
(With an administrator CLI profile, `oci os object bulk-download --prefix "<UTC stamp>-manual/"`
does the same in one command.)

Then, from the repository (Git Bash, Docker running):

```bash
deploy/bin/restore-test.sh --dir C:/restore-test/<UTC stamp>-manual --identity smartops-backup-key.txt
```

It verifies the checksums, decrypts, restores into a throw-away Postgres and counts rows. Delete the
downloaded folder afterwards. Repeat monthly; the Healthchecks reminder arrives in M6.

## Troubleshooting

| Symptom                                           | Likely cause                                                                        |
| ------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `NotAuthorizedOrNotFound` on the first upload     | Dynamic group or policy not applied yet (up to ~1 h), or wrong `OCI_NAMESPACE`      |
| Selftest says "it WORKED, it must be refused"     | The policy is wider than planned: run the setup script again, it rewrites it        |
| `upload … failed` three times, error mentions DNS | The VM has no route to Object Storage: check the subnet's route table / egress rule |
| `BucketNotFound`                                  | Wrong `OCI_BUCKET` or namespace in `backup.env`                                     |
