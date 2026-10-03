# ADR-026: Append-only encrypted backups to Object Storage, uploaded by a pinned OCI CLI container

Date: 2026-10-03
Status: accepted

## Context

The demo VM (1 GB, ADR-023) can be lost or compromised, so its backups must live elsewhere and
must survive a thief with root on the VM. Oracle Object Storage is inside the Always Free
allowance (20 GB, 50k requests/month). The VM has about 268 MiB of free memory with the demo
running, so the uploader's memory peak matters.

## Decision

1. **Encryption**: `age` to the owner's public key (private key only on the owner's PC; restore
   tests run there). Unchanged from ADR-023.
2. **Identity**: the VM uses its **instance principal** through a dynamic group that matches
   exactly this instance (`instance.id = '<OCID>'`). No API key is stored on the VM.
3. **Append-only policy**, scoped to one bucket (`smartops-backups`): the VM may read the bucket
   metadata and create / inspect objects (`OBJECT_CREATE`, `OBJECT_INSPECT`). It cannot overwrite,
   delete or read an object. The Object Storage service principal (`objectstorage-<region>`) gets
   the delete permissions its **lifecycle rule** needs: objects are removed after 30 days by the
   service, never by the VM.
4. **Unique names** (`<UTC stamp>-<reason>/<file>`) and `--no-overwrite`; the namespace is passed
   explicitly because the VM's policy does not allow looking it up.
5. **Uploader**: the official `ghcr.io/oracle/oci-cli` image, pinned by digest, run as root with
   `--cap-drop ALL`, `no-new-privileges` and `--memory 192m`.
6. `deploy/bin/backup-selftest.sh` proves from the VM that it can create and list but is refused
   overwrite, delete and read. `scripts/oci/setup-backup-bucket.ps1` (owner's PC, administrator
   profile, idempotent, `-DryRun`) creates the dynamic group, bucket, policy and lifecycle rule.

## Uploader measurement (2026-10-03, 3 MiB upload against a fake Object Storage endpoint)

| Option                                | Peak RSS                | Disk    | Notes                                 |
| ------------------------------------- | ----------------------- | ------- | ------------------------------------- |
| OCI CLI in the pinned container       | 62 MiB (cgroup peak 58) | image   | no Python on the host, digest-pinned  |
| OCI CLI in a venv (`oci-cli==3.94.0`) | 71–74 MiB               | 768 MiB | 49 s to install, host Python to patch |
| Python SDK only (`oci`)               | 53 MiB                  | 543 MiB | own upload code to write and maintain |

The whole pipeline (`pg_dump` → `age` → upload) stays around 100 MB, and the real dump is 321 KiB.
The three options differ by less than 20 MiB, so the decision is by supply chain and upkeep, not
memory: the container is pinned by digest, adds nothing to the host and needs no code of ours.
`backup.sh` records the lowest available memory seen during each run in its log and in the
Healthchecks body, so a regression shows up.

## Consequences

- A stolen VM can add junk objects (bounded by Always Free limits) but cannot destroy or leak
  backups. Retention is enforced by Oracle, not by the VM.
- A dynamic-group change can take about an hour to apply; the guide says so.
- The first version of the OCI branch could never have worked (root-owned 600 files unreadable by
  the image's user, `--force`, no namespace); the harness now runs the real script against a fake
  CLI image that checks arguments and readability.
- The real instance-principal path can only be proven on the VM: `backup-selftest.sh`.
