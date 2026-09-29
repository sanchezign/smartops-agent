# M1 — Oracle Cloud step by step (phase 12)

A guide to create, **at $0**, everything the public demo needs on Oracle Cloud: the account, a
budget with alerts, the network, a fixed public IP, the VM, SSH access through Bastion and the
DuckDNS name. It is written for someone who has **never used Oracle Cloud**. Nothing in this
guide installs the demo yet: that is M2 (hardening the VM) and M3 (first deploy).

> Oracle's screens are renamed often. If a button is not called exactly the same, pick the
> closest one; the **values** to enter are the ones in this guide.

**Golden rules for all of M1**

- **Never click "Upgrade to Pay As You Go"** (not even when the console suggests it to get
  capacity). According to Oracle, the card is not charged unless you upgrade the account.
- **Only resources labeled "Always Free-eligible"**. If a shape, image or service does not have
  the label, do not create it.
- **Do not touch** anything that is not in this guide (databases, Kubernetes, load balancers,
  VPN, NAT gateway, AMD instances, etc.).
- **No secrets in screenshots or in the chat with me**: you can send IPs, names and error
  messages, never private keys or the DuckDNS token.

**What you will have at the end (send it to me for M2):**

| Item                        | Example                                         |
| --------------------------- | ----------------------------------------------- |
| Home region                 | `sa-saopaulo-1` (São Paulo)                     |
| The VM's reserved public IP | `144.22.x.y`                                    |
| The VM's private IP         | `10.0.0.23`                                     |
| DuckDNS name                | `smartops-demo.duckdns.org`                     |
| VM shape                    | `VM.Standard.A1.Flex`, 1 OCPU, 3 GB             |
| Bastion test result         | "I got in" / "I did not get in + error message" |

Estimated time: 1 to 2 hours (plus retries if "Out of capacity" shows up).

---

## Step 0 — Before you start (on your computer)

### 0.1 SSH key

The VM only accepts an SSH key (never a password). If you already have an **ed25519** key that
you use only for servers, you can use it; otherwise create a new one. In PowerShell:

```powershell
ssh-keygen -t ed25519 -f $HOME\.ssh\smartops_oci -C "smartops-oci"
```

- It asks for a **passphrase**: set one (it protects the key if someone copies the file).
- Two files are created: `smartops_oci` (**private — it never leaves your computer**) and
  `smartops_oci.pub` (public — this is the one uploaded to Oracle).

**Check:** `Get-Content $HOME\.ssh\smartops_oci.pub` shows a line that starts with
`ssh-ed25519`.

### 0.2 Your public IP (for plan B)

Open https://ifconfig.me on your computer and write down the IP. It is only used if Bastion
fails (step 7).

---

## Step 1 — Create the account (home region: São Paulo)

1. Go to https://www.oracle.com/cloud/free/ → **Start for free**.
2. Account data:
   - **Country/Territory:** Uruguay.
   - **Cloud Account Name:** something without personal data, for example `smartopsdemo` (it is
     part of the login URL and cannot be changed).
   - **Home Region:** **Brazil East (São Paulo)**. If it does not show up or gives a capacity
     error at sign-up, **Chile Central (Santiago)**.

   > ⚠️ **The home region can never be changed**, and Always Free resources can only be created
   > there. Double-check it before going on.

3. Card verification: Oracle asks for a card to verify your identity. A **temporary hold** may
   appear and is released by itself; it is not a charge.
4. Wait for the "Your account is ready" email (it can take minutes to hours).

**Check:** in the console, the top right says **Brazil East (Sao Paulo)** (or Chile Central if
you took plan B).

**Do not touch:** the "Upgrade" banner or the trial of paid services.

---

## Step 2 — A USD 1 budget with alerts

The budget **stops nothing**: it only emails you if any spend appears. It is the early warning
that something was not Always Free.

1. Menu ☰ → **Billing & Cost Management** → **Budgets** → **Create Budget**.
2. Values:
   - **Name:** `smartops-cero-gasto` (zero spend)
   - **Target:** _Compartment_ → the **root** compartment (the one named after your account).
   - **Schedule:** _Monthly_.
   - **Budgeted amount:** `1` (USD).
3. **Budget alert rule** (first rule):
   - **Threshold metric:** _Actual Spend_
   - **Threshold type:** _Percentage of Budget_ → `1` (%, that is USD 0.01)
   - **Email recipients:** your email.
   - **Message:** `SmartOps: a charge appeared on Oracle Cloud. Check Cost Analysis.`
4. Save and add a **second rule** that is the same but with **Threshold metric: Forecast Spend**.

**Check:** Budgets shows `smartops-cero-gasto` with 2 alert rules. The budget is evaluated every
24 h, so do not expect an email right away.

---

## Step 3 — Compartment (for order, no cost)

1. Menu ☰ → **Identity & Security** → **Compartments** → **Create Compartment**.
2. **Name:** `smartops` · **Description:** `SmartOps public demo` · **Parent:** the root.

From here on, **everything is created in the `smartops` compartment** (there is a compartment
selector on the left of every screen).

---

## Step 4 — Network (VCN, internet gateway, subnet and rules)

We create the network **by hand** (not with the "VCN with Internet Connectivity" wizard, which
adds a NAT gateway and other pieces we do not need).

### 4.1 VCN

1. Menu ☰ → **Networking** → **Virtual Cloud Networks** → **Create VCN**.
2. **Name:** `smartops-vcn` · **Compartment:** `smartops` · **IPv4 CIDR block:** `10.0.0.0/16`.
   Leave IPv6 unchecked. **Create VCN**.

### 4.2 Internet Gateway

1. Inside `smartops-vcn` → **Gateways** (or _Internet Gateways_) → **Create Internet Gateway**.
2. **Name:** `smartops-igw`. **Create**.

### 4.3 Route to the internet

1. Inside the VCN → **Route Tables** → **Default Route Table for smartops-vcn**.
2. **Add Route Rules**:
   - **Target Type:** _Internet Gateway_
   - **Destination CIDR Block:** `0.0.0.0/0`
   - **Target Internet Gateway:** `smartops-igw`

### 4.4 Ingress rules (security list)

1. Inside the VCN → **Security Lists** → **Default Security List for smartops-vcn**.
2. **Ingress Rules**: you will see a rule for **TCP 22 from `0.0.0.0/0`**. **Delete it** (SSH is
   never open to the internet). Keep the default ICMP rules.
3. **Add Ingress Rules** (three rules, _Stateless_ unchecked, _IP Protocol: TCP_):

   | Source CIDR   | Destination Port | What for                                      |
   | ------------- | ---------------- | --------------------------------------------- |
   | `0.0.0.0/0`   | `80`             | HTTP (Caddy redirects it to HTTPS)            |
   | `0.0.0.0/0`   | `443`            | The demo's HTTPS                              |
   | `10.0.0.0/24` | `22`             | SSH **only from inside the subnet** (Bastion) |

4. **Egress Rules:** keep the default one (all outbound traffic allowed).

**Check:** the ingress rules are exactly ICMP (the defaults), `80` and `443` from `0.0.0.0/0`,
and `22` **only** from `10.0.0.0/24`.

### 4.5 Public subnet

1. Inside the VCN → **Subnets** → **Create Subnet**.
2. Values:
   - **Name:** `smartops-public`
   - **Subnet Type:** _Regional_
   - **IPv4 CIDR Block:** `10.0.0.0/24`
   - **Route Table:** _Default Route Table for smartops-vcn_
   - **Subnet Access:** _Public Subnet_
   - **Security List:** _Default Security List for smartops-vcn_
3. **Create Subnet**.

**Do not touch:** NAT gateway, Service gateway, DRG, VPN, Load Balancer.

---

## Step 5 — Reserved public IP

A **reserved** IP does not change even if you delete and recreate the VM (so DuckDNS is set only
once).

1. Menu ☰ → **Networking** → **IP Management** → **Reserved Public IPs** → **Reserve Public IP
   Address**.
2. **Name:** `smartops-demo-ip` · **Compartment:** `smartops` · _Create new_ (not "from IP pool").

**Check:** `smartops-demo-ip` appears with an `x.x.x.x` address and state _Available_. Write down
the IP.

> 💲 Oracle announced reserved public IPs **at no cost**; I could not confirm it on an official
> price page. The step 2 budget would warn about any spend, and in step 9 we check it in _Cost
> Analysis_.

---

## Step 6 — The VM (1 OCPU / 3 GB, Ubuntu 24.04 ARM)

1. Menu ☰ → **Compute** → **Instances** → **Create Instance**.
2. **Name:** `smartops-demo` · **Compartment:** `smartops`.
3. **Placement:** keep the default _Availability Domain_ (São Paulo has only one).
4. **Image and shape** → **Edit**:
   - **Image:** _Change image_ → **Canonical Ubuntu** → **24.04** (the regular one, **not**
     "Minimal"). It must say _Always Free-eligible_.
   - **Shape:** _Change shape_ → **Ampere** → **VM.Standard.A1.Flex** (_Always Free-eligible_).
     - **Number of OCPUs:** `1`
     - **Amount of memory (GB):** `3`

     > Why 3 GB and not more: Oracle may reclaim an Always Free VM if, over 7 days, CPU, network
     > **and memory** stay below 20 %. The demo uses about 0.7 GB; with 3 GB the threshold is
     > 0.6 GB. It can be enlarged later without reinstalling.
5. **Networking** → **Edit**:
   - _Select existing virtual cloud network_ → `smartops-vcn`
   - _Select existing subnet_ → `smartops-public`
   - **Public IPv4 address:** _Do not assign_ (in step 6.1 we assign the reserved one).
6. **Add SSH keys:** _Upload public key files (.pub)_ → `smartops_oci.pub` (the **public** one).
7. **Boot volume:** keep the default size (50 GB). Do **not** check "Use in-transit encryption"
   if it asks to change the shape, nor other advanced options.
8. **Create**.

**If "Out of capacity for shape VM.Standard.A1.Flex" appears**: it is a temporary shortage of ARM
machines in the region, not your mistake. Retry at other times (early morning or night often
works better) for a few days — or use the automatic retry,
[m1-retry-launch.md](m1-retry-launch.md). Do **not** switch to Pay As You Go or to a shape
without the Always Free label. If after several days there is still no luck, we decide together.

**Check:** the instance is **RUNNING**, _Shape_ `VM.Standard.A1.Flex`, _OCPU count_ 1, _Memory_
3 GB. Under **Primary VNIC**, write down the **Private IPv4 address** (e.g. `10.0.0.23`).

### 6.1 Assign the reserved IP

1. In the instance → **Attached VNICs** (or _Networking_) → the primary VNIC → **IPv4
   Addresses**.
2. On the primary private IP → ⋮ → **Edit** → **Public IP type:** _Reserved public IP_ →
   _Select existing_ → `smartops-demo-ip` → **Update**.

**Check:** the instance shows the reserved IP from step 5 as its _Public IPv4 address_.

### 6.2 Enable the Bastion plugin (just in case)

In the instance → **Oracle Cloud Agent** → enable **Bastion** if it is disabled. (The step 7
_port forwarding_ session does not need it, but it does no harm.)

---

## Step 7 — SSH access through Bastion (and plan B)

Port 22 is not open to the internet. We go in through Oracle's **Bastion** service (free): it
creates a temporary tunnel (3 h at most) to the VM.

### 7.1 Create the bastion

1. Menu ☰ → **Identity & Security** → **Bastion** → **Create bastion**.
2. Values:
   - **Name:** `smartopsbastion` (letters and digits only)
   - **Target virtual cloud network:** `smartops-vcn`
   - **Target subnet:** `smartops-public`
   - **CIDR block allowlist:** your IP from step 0.2 with `/32` (e.g. `190.64.x.y/32`). If your
     IP changes often, you can use `0.0.0.0/0`: your private key is still needed to get in.
3. **Create bastion** and wait until it is **Active**.

### 7.2 Create a session

1. In the bastion → **Create session**.
2. Values:
   - **Session type:** _SSH port forwarding session_
   - **Session name:** `smartops-ssh`
   - **Connect to the target host by using:** _IP address_ → the VM's **private IP** (step 6)
   - **Port:** `22`
   - **SSH key:** _Choose SSH key file_ → `smartops_oci.pub`
   - **Maximum session time-to-live:** 180 minutes (the maximum)
3. **Create session** and wait for **Active**.
4. In the session → ⋮ → **Copy SSH command**. It looks like this (yours has other values):

   ```text
   ssh -i <privateKey> -N -L <localPort>:10.0.0.23:22 -p 22 ocid1.bastionsession.oc1.sa-saopaulo-1.xxxx@host.bastion.sa-saopaulo-1.oci.oraclecloud.com
   ```

### 7.3 Test it (two PowerShell terminals)

Terminal 1 (the tunnel; it seems to "hang", which is normal):

```powershell
ssh -i $HOME\.ssh\smartops_oci -N -L 2222:10.0.0.23:22 -p 22 ocid1.bastionsession....@host.bastion.sa-saopaulo-1.oci.oraclecloud.com
```

(replace `<privateKey>` with your key and `<localPort>` with `2222`; the rest exactly as copied.)

Terminal 2 (into the VM through the tunnel):

```powershell
ssh -i $HOME\.ssh\smartops_oci -p 2222 ubuntu@localhost
```

The first time it asks whether you trust the server's fingerprint: answer `yes`.

**Check, once inside the VM:**

```bash
uname -m           # aarch64
free -h            # total memory ≈ 2.8 Gi
lsb_release -d     # Ubuntu 24.04…
curl -s ifconfig.me; echo    # the reserved IP from step 5
exit
```

If all of that works: **Bastion works** and is the permanent path. Write down "I got in".

### 7.4 Plan B (only if 7.3 fails)

If you could not get in (write down the exact error message to send me):

1. **Security List** (step 4.4) → **Add Ingress Rule**: _Source CIDR_ = your IP from step 0.2
   with `/32`, _TCP_, _Destination Port_ `22`.
2. Go in directly: `ssh -i $HOME\.ssh\smartops_oci ubuntu@<reserved IP>`.
3. If your home IP changes, you will have to update that rule (ifconfig.me tells you the new
   one).

**Do not:** open port 22 to `0.0.0.0/0`.

---

## Step 8 — A free name on DuckDNS

1. Go to https://www.duckdns.org and sign in (GitHub or Google).
2. In **sub domain**, type the name (without personal data), for example `smartops-demo`,
   → **add domain**.
3. In the domain's row, in **current ip**, delete whatever is there, paste the **reserved IP**
   from step 5 → **update ip**.
4. The **token** the page shows is like a password: keep it in your password manager. **It never
   goes to the VM or the repository** (the IP does not change, so there is no need to update it
   from the server).

**Check** (in PowerShell; it can take a few minutes):

```powershell
Resolve-DnsName smartops-demo.duckdns.org -Type A
```

It must return the reserved IP. (The page does not load anything yet: the demo is installed in
M3.)

---

## Step 9 — Check the "zero spend" (after 24–48 h)

1. Menu ☰ → **Billing & Cost Management** → **Cost Analysis**: the month's total must be
   **0.00**. If anything appears, see which service it is and tell me.
2. **Subscriptions** (or _Upgrade and Manage Payment_): the account is still on **Free Tier** (or
   _Free Trial_ for the first 30 days), **without** "Pay As You Go".
3. Menu ☰ → **Governance & Administration** → **Limits, Quotas and Usage**: filter _Compute_ →
   the _Standard.A1 cores_ usage is 1 of 2 and the memory 3 of 12 GB.

---

## What to send me at the end

- Region, reserved IP, private IP, DuckDNS name and VM shape (the table at the start).
- The Bastion result (step 7.3) or plan B's, with the error message if there was one.
- Any screen where something did not match the guide (without keys or tokens).

With that I send you M2: hardening the VM with `deploy/bin/host-setup.sh` (SSH, firewall,
automatic updates, Docker) — you run it; I have no access to the VM.
