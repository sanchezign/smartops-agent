# M1 — Automatic retry to create the VM (phase 12)

> **ON HOLD (2026-10-02).** After 420 failed attempts the demo moved to an E2.1.Micro (ADR-023).
> The script and this guide stay in the repository for when A1 capacity is wanted again.
> The launcher identity was deleted on 2026-10-07 (user `smartops-launcher`, its API key, group
> `smartops-launchers`, policy `smartops-launcher-policy`): a new retry starts again at step 2.

São Paulo has no ARM capacity ("500-InternalError, Out of host capacity"). Instead of retrying
by hand, a script runs **on your computer** and tries to create the VM every 2–5 minutes (with
random jitter) for up to 5 days, without Pay As You Go. It uses the **OCI CLI** with a
**separate least-privilege user** (`smartops-launcher`), not your administrator user. As soon as
the VM exists, that user and its key are deleted.

Script: [`scripts/oci/launch-retry.ps1`](../../scripts/oci/launch-retry.ps1). Previous guide:
[`m1-oracle-setup.md`](m1-oracle-setup.md) (after the VM is created, continue from its step 6.1).

> 🔒 **Never paste** the private key (`.pem`), the contents of `~/.oci/config` or tokens into a
> chat. The script's log is safe to share: it holds no secrets.

> The script still prints its messages in Spanish; they are quoted here as they appear. They
> become English in a later phase 12 milestone.

## What the script does (and does not do)

- **Before every attempt** it looks for a `smartops-demo` instance in the `smartops`
  compartment (in any state except terminated). If one exists, it **does not create another**
  and stops.
- It creates the VM with the approved configuration, fixed in the script:
  `VM.Standard.A1.Flex`, **1 OCPU / 3 GB**, Ubuntu 24.04 aarch64 (not Minimal), subnet
  `smartops-public`, **no public IP** (the reserved one is assigned by hand later), your public
  key `smartops_oci.pub`.
- "Out of host capacity" → waits 2–5 min (random) and retries. Too many calls (429) → 15 min.
- **Network failures** (timeouts, DNS, refused or reset connections, "Max retries exceeded", or
  any failure without an answer from OCI), both when listing and when creating → it **waits and
  retries**, it does not stop. This is safe: before every attempt it checks whether the VM
  already exists (if an earlier attempt created it but the answer was lost, it finds it and stops
  without creating another). Every **12 failures in a row** it warns you in the log and with a
  notification, and it keeps going until the deadline.
- **Real errors** (authentication 401, permissions 404, limits, parameters, or the local OCI CLI
  configuration) → it **stops**, warns you and leaves a hint in the log. It never retries blindly.
- When it succeeds: it stops, with a **Windows notification + sound**.
- A local log without secrets: `%LOCALAPPDATA%\smartops\launch-retry.log`.
- While it runs, it **asks Windows not to put the computer to sleep** (released when it ends).
- After 5 days without capacity it stops, and we decide together.

**Why it launches the instance directly instead of a Resource Manager stack job**: a single API
call returns the exact error code (capacity vs. authentication vs. limits), which is what lets
the script stop on anything that is not capacity. Stack jobs wrap Terraform: errors end up inside
logs, each attempt takes about 1 minute, and they leave a job history and a Terraform state that
can stay "failed". They would also need more permissions (`orm-stacks` / `orm-jobs` on top of
the instance ones). The `smartops-demo-vm` stack remains as a record of the configuration and is
deleted in the cleanup.

---

## Step 1 — Install the OCI CLI on Windows

1. Open https://github.com/oracle/oci-cli/releases, download the **Windows MSI installer** of the
   latest version and run it (Next → Next → Finish).
2. Open a **new PowerShell** (a normal one; administrator is not needed) and check:

   ```powershell
   oci --version
   ```

   It must print a version number (for example `3.94.0`).

## Step 2 — Least-privilege user, group and policy

New Oracle accounts use **Identity Domains**: users and groups live in the **Default** domain.
You do all of this with your administrator user in the console.

### 2.1 User `smartops-launcher`

1. Menu ☰ → **Identity & Security** → **Domains** → **Default** → **User management** →
   **Users** → **Create user**.
2. Values:
   - **First name:** `SmartOps` · **Last name:** `Launcher`
   - **Username / Email:** Oracle requires an email. Use an alias of your mailbox, for example
     `your.user+smartops-launcher@gmail.com` (it arrives in the same inbox).
   - Do **not** give it administrator roles or add it to _Administrators_.
3. **Create**. If a console activation email arrives, **ignore it**: this user never signs in to
   the console, it only uses the API key.

### 2.2 Group `smartops-launchers`

1. In the same domain → **User management** → **Groups** → **Create group**.
2. **Name:** `smartops-launchers` · **Description:** `Only create the demo VM` · add the user
   `smartops-launcher`. **Create**.

### 2.3 Policy

1. Menu ☰ → **Identity & Security** → **Policies**. On the left, choose the **root** compartment
   (the account's; the policy has one "in tenancy" line).
2. **Create Policy** → **Name:** `smartops-launcher-policy` → **Description:** `Create the demo VM
in smartops` → **Show manual editor**, and paste exactly:

   ```text
   Allow group 'Default'/'smartops-launchers' to manage instance-family in compartment smartops
   Allow group 'Default'/'smartops-launchers' to use volume-family in compartment smartops
   Allow group 'Default'/'smartops-launchers' to use virtual-network-family in compartment smartops
   Allow group 'Default'/'smartops-launchers' to read app-catalog-listing in tenancy
   ```

   This is Oracle's official "Let users launch compute instances" recipe, **limited to the
   `smartops` compartment**: it can create and view instances, use that compartment's network and
   disks, and read the image catalog. It cannot touch other compartments, billing or identity.

3. **Create**.

**Check:** Policies shows `smartops-launcher-policy` with 4 statements.

### 2.4 API key (generated in the console)

1. **Domains** → **Default** → **Users** → `smartops-launcher` → **API keys** → **Add API key**.
2. **Generate API key pair** → **Download private key** (a `.pem` file) → **Add**.
3. A **Configuration file preview** appears: keep that window open (you use it in step 3).
4. Move the downloaded `.pem` to `C:\Users\<your user>\.oci\smartops_launcher.pem` (create the
   `.oci` folder if it does not exist). **Never** put it inside the repository or in Drive /
   OneDrive.
5. Restrict its permissions:

   ```powershell
   oci setup repair-file-permissions --file $HOME\.oci\smartops_launcher.pem
   ```

## Step 3 — Configure `~/.oci/config`

1. Open (or create) `C:\Users\<your user>\.oci\config` with Notepad.
2. Add a `[SMARTOPS]` section with the values from the **Configuration file preview**:

   ```ini
   [SMARTOPS]
   user=ocid1.user.oc1..(the one in the preview)
   fingerprint=(the one in the preview)
   tenancy=ocid1.tenancy.oc1..(the one in the preview)
   region=sa-saopaulo-1
   key_file=C:\Users\<your user>\.oci\smartops_launcher.pem
   ```

   (If the file already had a `[DEFAULT]` section, leave it as it is.)

3. Restrict the configuration file too:

   ```powershell
   oci setup repair-file-permissions --file $HOME\.oci\config
   ```

## Step 4 — Test the connection (without creating anything)

1. Copy the **OCID of the `smartops` compartment**: Identity & Security → Compartments →
   `smartops` → _OCID_ → **Copy**.
2. Authentication test:

   ```powershell
   oci --profile SMARTOPS iam region list --output table
   ```

   It must list regions. If it says `NotAuthenticated`: check the fingerprint, `key_file`, and
   that the API key belongs to the `smartops-launcher` user.

3. **Dry run of the script** (resolves the subnet, the availability domain and the image, and
   checks that the VM does not exist yet; it **creates nothing**):

   ```powershell
   cd C:\dev\smartops-agent
   powershell -ExecutionPolicy Bypass -File scripts\oci\launch-retry.ps1 -CompartmentId <OCID of smartops> -DryRun
   ```

   Expected: lines `subred smartops-public = …` (subnet), `dominio de disponibilidad = …`
   (availability domain), `imagen = Canonical-Ubuntu-24.04-aarch64-…` (image) and, at the end,
   `DRYRUN todo resuelto…` (everything resolved).

   - If it stops while _listing availability domains_ with `NotAuthorizedOrNotFound`: copy the
     domain name from the _Create Instance_ screen (something like `Xyz1:SA-SAOPAULO-1-AD-1`) and
     add `-AvailabilityDomain "Xyz1:SA-SAOPAULO-1-AD-1"` to the command.
   - Any other error: send me the `STOP` line and the `HINT` line from the log.

## Step 5 — Get the computer ready for several days

- **Plugged in** (if it is a laptop) with the **lid open**, or set _Settings → System → Power →
  Lid actions_ to "Do nothing" while it runs.
- The script asks Windows not to sleep; you can check it with `powercfg /requests`
  (`powershell.exe` appears under **SYSTEM**).
- **Windows Update**: _Settings → Windows Update → Pause updates_ for 1 week, so it does not
  restart by itself.
- The screen may turn off; that does not stop the script.

## Step 6 — Run the retry

In a PowerShell window that you will leave open:

```powershell
cd C:\dev\smartops-agent
powershell -ExecutionPolicy Bypass -File scripts\oci\launch-retry.ps1 -CompartmentId <OCID of smartops>
```

- Every attempt shows on screen and in the log (`CAPACITY intento 12: 500 InternalError Out of
host capacity. -> proximo en 7,3 min` = attempt 12, next one in 7.3 min).
- To watch the log from another window:
  `Get-Content $env:LOCALAPPDATA\smartops\launch-retry.log -Tail 20 -Wait`
- **To stop it:** `Ctrl + C` in its window (or close it). Starting it again is safe: it first
  checks whether the VM already exists.

When it succeeds: the notification **"SmartOps: VM creada!"** (VM created) + a sound, and a
`SUCCESS` line in the log. Continue with **step 6.1** of
[`m1-oracle-setup.md`](m1-oracle-setup.md) (assign the reserved IP) and the rest of that guide
(Bastion, checks).

If you see **"sin conexion con OCI"** warnings (no connection to OCI, 12 failures in a row):
check the computer's internet connection; the script keeps going by itself, there is no need to
stop it.

If it stops by itself (`STOP`): read the `HINT` line, fix the cause and run it again; if it is
not clear, send me those two lines.

## Step 7 — Cleanup (as soon as the VM is RUNNING)

The launch user is no longer needed: **delete it with its key**.

1. **Domains → Default → Users → `smartops-launcher` → API keys**: delete the key.
2. Delete the user `smartops-launcher` (Users → ⋮ → _Delete_).
3. **Groups**: delete `smartops-launchers`.
4. **Policies** (root compartment): delete `smartops-launcher-policy`.
5. On your computer:
   - delete `C:\Users\<your user>\.oci\smartops_launcher.pem`;
   - remove the `[SMARTOPS]` section from `C:\Users\<your user>\.oci\config`.
6. **Resource Manager → Stacks → `smartops-demo-vm`**: check that _Stack resources_ is empty (the
   failed attempts created nothing) and delete the stack.
7. Resume Windows Update and set the power settings back as they were.
8. (Optional) Uninstall the OCI CLI from _Installed apps_.

**Check:** Users no longer shows `smartops-launcher` and Policies no longer has the policy.
