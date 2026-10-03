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

## 2. The bucket, group and policy (your PC, administrator profile)

You need the OCI CLI with your **administrator** profile (not the Bastion or launcher users) and:

- the compartment OCID of `smartops` (Console → Identity → Compartments);
- the VM's OCID (Console → Compute → Instances → `smartops-demo-micro` → OCID → Copy).

Look at the plan first, nothing changes with `-DryRun`:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\oci\setup-backup-bucket.ps1 `
  -CompartmentId ocid1.compartment.oc1..xxxx -InstanceId ocid1.instance.oc1.sa-saopaulo-1.xxxx -DryRun
```

Read the three policy statements it prints. They must say exactly this (domain and region may
differ):

```text
Allow dynamic-group 'Default'/'smartops-vm' to read buckets in compartment smartops where target.bucket.name = 'smartops-backups'
Allow dynamic-group 'Default'/'smartops-vm' to manage objects in compartment smartops where all {target.bucket.name = 'smartops-backups', any {request.permission = 'OBJECT_CREATE', request.permission = 'OBJECT_INSPECT'}}
Allow service objectstorage-sa-saopaulo-1 to manage object-family in compartment smartops where any {…delete permissions…}
```

If it all looks right, run it again without `-DryRun` and type `yes`. It is **idempotent**: running it
again changes nothing that is already right. At the end it prints two lines:

```ini
OCI_BUCKET=smartops-backups
OCI_NAMESPACE=<your tenancy namespace>
```

If the Console shows your identity domain with another name (Identity → Domains), pass
`-IdentityDomain <name>`. If your tenancy has no identity domains, tell me: the statement uses
`dynamic-group smartops-vm` without the domain prefix.

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

Expected: `PASS` for creating and listing, `PASS … -> refused` for writing the same name again,
overwriting, deleting, reading back and deleting the bucket, then `SELFTEST PASSED`. It leaves one
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

Download that folder with your administrator profile (the VM could not do this, you can):

```powershell
oci os object bulk-download --namespace-name <namespace> --bucket-name smartops-backups `
  --prefix "<UTC stamp>-manual/" --download-dir C:\restore-test
```

Then, from the repository (Git Bash, Docker running):

```bash
deploy/bin/restore-test.sh --dir C:/restore-test/<UTC stamp>-manual --identity smartops-backup-key.txt
```

It verifies the checksums, decrypts, restores into a throw-away Postgres and counts rows. Delete the
downloaded folder afterwards. Repeat monthly; the Healthchecks reminder arrives in M6.

## Troubleshooting

| Symptom                                               | Likely cause                                                                        |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `NotAuthorizedOrNotFound` on the first upload         | Dynamic group or policy not applied yet (up to ~1 h), or wrong `OCI_NAMESPACE`      |
| Selftest says "it WORKED, it must be refused"         | The policy is wider than planned: run the setup script again, it rewrites it        |
| `upload … failed` three times, error mentions DNS     | The VM has no route to Object Storage: check the subnet's route table / egress rule |
| `BucketNotFound`                                      | Wrong `OCI_BUCKET` or namespace in `backup.env`                                     |
| Setup script: "Listing dynamic groups: NotAuthorized" | You ran it with a restricted profile; use the administrator one                     |
