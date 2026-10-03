# SSH to the demo VM through OCI Bastion, on demand (phase 12, M3b)

The VM has no open SSH port. You reach it through an OCI Bastion **port forwarding** session, and the
bastion only accepts connections from its **CIDR allowlist** (your home IP as a `/32`). Your home IP
changes often, so one PowerShell command does the whole dance:
[`scripts/oci/bastion-connect.ps1`](../../scripts/oci/bastion-connect.ps1). It runs on **your PC**
(Windows, PowerShell 5.1) with the OCI CLI and an IAM user that can do **only** that.

What one run does: finds your public IPv4 → sets the allowlist to `<ip>/32` if it is not already
(existing sessions are unaffected) → creates an **ephemeral** SSH key and a session to the VM's
private IP, port 22 (TTL 3 h, the maximum) → opens the tunnel and your interactive SSH (with
`ServerAliveInterval=30`) → on exit closes the tunnel, **deletes the session** and the key.

> The manual way (Console, 2 minutes) stays as the fallback: [runbook, section 9](../runbook.md).
> Oracle's guidance is a small allowlist and **never `0.0.0.0/0`**, and a new key per session.

## One-time setup (about 15 minutes, yours)

### 1. The IAM user and group (Console)

_Identity & Security → Domains → Default → Groups → Create group_ `smartops-bastion-users`;
_Users → Create user_ `smartops-bastion` (no password login is needed; add it to the group).

### 2. The policy (the narrowest that works)

_Identity & Security → Policies → Create policy_ in the **root** compartment, name
`smartops-bastion-policy`. Start with these three statements (replace `smartops` with the
compartment of the bastion if it differs):

```text
Allow group 'Default'/'smartops-bastion-users' to use bastion in compartment smartops
Allow group 'Default'/'smartops-bastion-users' to manage bastion in compartment smartops where request.operation = 'UpdateBastion'
Allow group 'Default'/'smartops-bastion-users' to manage bastion-session in compartment smartops
```

Why: `use bastion` covers reading the bastion and creating / deleting sessions; updating the
allowlist is `UpdateBastion`, which Oracle files under `manage bastion`, so it is allowed **only for
that operation** (the `request.operation` variable); sessions need `manage bastion-session`. Oracle's
policy reference also lists reads of instances, subnets, VCNs and VNICs, the instance-agent plugins
and work requests for `CreateSession`; for a target given by **IP address** they may not be needed.
The probe tells you:

1. Run the tool with `-Probe` (step 4 below). Every `FAIL` line names what to add.
2. Add only that (for example `Allow group … to read instances in compartment smartops`), run the
   probe again, until it prints `PROBE PASSED`.
3. Then prune: remove each extra statement you added, one at a time, and run the probe again; keep
   only those whose removal makes it fail.

### 3. An API key **with its own passphrase** for that user

On your PC (OCI CLI installed). It asks for the passphrase; choose a strong one that is not your
other passwords:

```powershell
oci setup keys --key-name smartops_bastion --output-dir $HOME\.smartops
```

Then, in the Console: _Users → smartops-bastion → API keys → Add API key → Paste a public key_ →
paste the content of `$HOME\.smartops\smartops_bastion_public.pem`. The Console shows a
configuration preview (user, fingerprint, tenancy, region). Add it to your `~/.oci/config` as a
**new profile**, with `key_file` pointing at the `.pem` you just made and **without** a
`pass_phrase` line:

```ini
[SMARTOPS_BASTION]
user=ocid1.user.oc1..xxxx
fingerprint=xx:xx:...
tenancy=ocid1.tenancy.oc1..xxxx
region=sa-saopaulo-1
key_file=C:\Users\<you>\.smartops\smartops_bastion.pem
```

The tool asks for the passphrase every run (hidden) and hands it to the OCI CLI through the
process-only variable `OCI_CLI_PASSPHRASE`. It is never written to a file or to the log.

### 4. First run

```powershell
# the bastion's OCID: Console → Bastion → smartopsbastion (saved afterwards in %LOCALAPPDATA%\smartops)
powershell -ExecutionPolicy Bypass -File scripts\oci\bastion-connect.ps1 -BastionId ocid1.bastion.oc1.sa-saopaulo-1.xxxx -Probe
powershell -ExecutionPolicy Bypass -File scripts\oci\bastion-connect.ps1 -DryRun
powershell -ExecutionPolicy Bypass -File scripts\oci\bastion-connect.ps1
```

## Daily use

| You want                           | Command                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| A shell on the VM                  | `powershell -ExecutionPolicy Bypass -File scripts\oci\bastion-connect.ps1`     |
| To copy files / use two terminals  | add `-TunnelOnly` (it prints the `ssh` and `scp` commands and waits for Enter) |
| To see what it would do            | add `-DryRun`                                                                  |
| To find a missing permission       | add `-Probe`                                                                   |
| Another local port / VM user / key | `-LocalPort 2223`, `-VmUser ubuntu`, `-IdentityFile <path>`                    |

## First real runs: what we learned (2026-10-03)

- **The probe passed with the initial three statements plus three reads** in the compartment:
  `read instance-family`, `read virtual-network-family` and `inspect work-requests`. Pruning them
  one by one (probe after each) is the next step.
- **"Permission denied (publickey)" right after the session is ACTIVE** is a propagation delay: the
  Bastion accepts the session's key a little later. The tool now retries the tunnel for up to 90 s
  (`-TunnelWaitSeconds`) and says so; if it still fails it tells apart "the key is not accepted" from
  "network / allowlist".
- **Typing the VM key's passphrase killed the tunnel** (`ssh_dispatch_run_fatal … Unknown error`):
  the tunnel's ssh shared the Windows console with the interactive ssh. It now runs with `-n` and with
  stdin / stdout redirected to files, so it cannot share the console.
- **`-SshDebug`** runs the tunnel's ssh with `-v` and writes what ssh said (the session OCID redacted,
  never a key or a passphrase) to `%LOCALAPPDATA%smartopsastion-ssh-debug.log`.

- **The interactive ssh uses only `-o ServerAliveInterval=30 -i <key> -p <port>`** (second real test).
  The first version also passed `HostKeyAlias=smartops-demo-vm`, `StrictHostKeyChecking=accept-new` and
  `ServerAliveCountMax=4`, and the connection died right after the key passphrase
  (`ssh_dispatch_run_fatal: Connection to 127.0.0.1 port 2222: Unknown error`) while the tunnel itself
  was fine. The tool now prints (and runs) the set that works. Because the host key is no longer
  stored under an alias, a tunnel on another local port asks once whether to trust the VM
  (`[localhost]:<port>`): answer `yes`.
- **`-SshDebug` now logs every attempt**, the one that worked included, and everything the live tunnel
  said until it closed.

### Which option broke it? (optional, to find out)

With a `-TunnelOnly` tunnel up on port 2222, one at a time (each should either work or die after the
passphrase). Replace the key path with yours:

```powershell
ssh -o ServerAliveInterval=30 -o HostKeyAlias=smartops-demo-vm -i $HOME\.ssh\smartops_oci -p 2222 ubuntu@localhost
ssh -o ServerAliveInterval=30 -o StrictHostKeyChecking=accept-new -i $HOME\.ssh\smartops_oci -p 2222 ubuntu@localhost
ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=4 -i $HOME\.ssh\smartops_oci -p 2222 ubuntu@localhost
```

### Testing it again

1. `... bastion-connect.ps1 -TunnelOnly -SshDebug` in terminal 1: it prints the `ssh` command and waits.
2. In terminal 2, paste that `ssh` command and type the VM key's passphrase. The tunnel must stay up.
3. Back in terminal 1 press Enter: tunnel closed, session deleted.
4. Then the normal mode (`... bastion-connect.ps1`) a few times: every run should open the tunnel,
   some after a "tunnel attempt N … retrying" line. If one fails, send
   `%LOCALAPPDATA%smartopsastion-ssh-debug.log`.

## Pruning the policy to the minimum, one statement at a time

The probe passed with the three initial statements plus three reads. Remove each extra statement
**alone** and run `-Probe` after it (IAM changes can take about a minute to apply):

| Step | Remove from the policy                                                                                                                                      | Run                          | If `PROBE PASSED`         | If it FAILS                |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------- | -------------------------- |
| 1    | `… to inspect work-requests in compartment smartops`                                                                                                        | `bastion-connect.ps1 -Probe` | leave it removed          | put it back (it is needed) |
| 2    | `… to read virtual-network-family in compartment smartops`                                                                                                  | `-Probe`                     | leave it removed          | put it back, go to step 4  |
| 3    | `… to read instance-family in compartment smartops`                                                                                                         | `-Probe`                     | leave it removed          | put it back, go to step 5  |
| 4    | (only if step 2 failed) replace the family by the resource types Oracle lists for `CreateSession`: `read vcns`, `read subnets`, `read vnics`, one at a time | `-Probe` after each          | keep only the ones needed | —                          |
| 5    | (only if step 3 failed) replace the family by `read instances`, `read vnic-attachments`, `read instance-agent-plugins`, one at a time                       | `-Probe` after each          | keep only the ones needed | —                          |

The result is the narrowest policy that still lets the tool update the allowlist and create / delete
sessions. Write the final statements here (and in CLAUDE.md) when you have them.

## If it fails

| Message                                                 | What to do                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `Updating the allowlist: NotAuthorizedOrNotFound`       | the `UpdateBastion` statement is missing or has the wrong compartment / group (step 2)      |
| `Creating the session: NotAuthorizedOrNotFound`         | run `-Probe`; add the statement it names                                                    |
| `NotAuthenticated`                                      | wrong passphrase, or the public key / fingerprint in the Console does not match the profile |
| `The Bastion still does not accept the session's key`   | not the allowlist: the key had not spread yet; run again, or with `-SshDebug`               |
| `The tunnel did not come up … NETWORK or the allowlist` | your IP is not in the allowlist yet, or your network blocks outbound port 22                |
| `No [SMARTOPS_BASTION] profile with a region`           | step 3 (the profile name must match `-OciProfile`)                                          |

## What a stolen API key could do (and why that is acceptable)

It is protected by its passphrase, and the user can only (a) rewrite the allowlist of this bastion
and (b) create sessions to it. It cannot touch anything else in the tenancy. An attacker would
still need **your VM login key** (`smartops_oci`) to get a shell. To cut it off: delete the API key
(Console → the user → API keys) or the user.

## Tests

`scripts\oci\tests\bastion-connect.tests.ps1` runs the tool against a fake `oci`, `ssh` and
`ssh-keygen` (no network, no Oracle account, no `~/.oci`): allowlist changes only when needed, the
session is always deleted, the passphrase never reaches a command line or the output, a missing
permission produces the right hint, `-DryRun` changes nothing, `-Probe` reports each step.
