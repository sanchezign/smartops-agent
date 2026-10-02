# ADR-023: $0 public demo on one Oracle Always Free E2.1.Micro

Date: 2026-10-02
Status: accepted (supersedes ADR-007)

## Context

The portfolio demo must run at **$0, with no card** (cost constraint, phase 12). The first plan
was an Always Free Ampere A1 VM (2 OCPU / 12 GB) with the whole stack including n8n. São Paulo
never had A1 capacity: 420 creation attempts failed with "Out of host capacity", also after
Oracle's notice that the account was fully provisioned. Alternatives checked against official
sources:

- **Pay As You Go** to get capacity: a US$100 card authorization at upgrade, irreversible in
  practice, and no official guarantee that it improves A1 availability. Discarded by the owner.
- **Render free + Supabase free**: services sleep after 15 minutes, the free database is paused
  after 7 idle days, the free workspace has a 5 GB bandwidth meter (US$0.15/GB beyond).
- **Hugging Face Docker Spaces**: creating them requires a paid plan.
- **Static panel with a simulated backend**: costs 4–6 days and does not show the real backend.

An **E2.1.Micro** (Always Free, no upgrade) was created: 1/8 OCPU, 1 GB RAM, x86_64, Ubuntu 24.04,
home region, one availability domain. On the VM: 954 MiB total, ~386 MiB used by the base system,
~567 MiB available, no swap.

## Decision

- The public demo runs on **one E2.1.Micro** with Docker Compose and Caddy (HTTPS, one origin for
  panel and API), reserved public IP, DuckDNS name, SSH only through OCI Bastion (port forwarding).
- It runs the **light demo profile** (ADR-025): no n8n, API + worker + internal orchestrator in
  one process, a tuned Postgres, the panel in standalone mode.
- The **full demo with n8n** is for when A1 capacity or a larger server exists. The full stack is
  still the product: the repository, the local `docker compose`, the contract tests and the demo
  video use n8n.
- Host: 2 GB swap file, Oracle Cloud Agent with only _Compute Instance Monitoring_ enabled,
  no fail2ban (port 22 is only reachable from the Bastion subnet; keys only), security updates
  with a 04:00 reboot, own memory check in the monitor.
- The A1 retry script (`scripts/oci/launch-retry.ps1`) stays in the repository, on hold.

## Why

Measured in a simulation capped at 550 MiB RAM + 2 GiB swap + 0.125 CPU (Docker inside the cap,
6 demo samples): the current stack with n8n does not work (6/6 timeouts at 240 s, 567 MiB of
swap); the light profile in one process needs ~423 MiB (RAM + swap), starts in 34 s and finishes
each sample in 1.8–8.4 s (median 5.9 s).

## Consequences

- The public demo does not show n8n live; docs say so explicitly.
- **Idle reclamation**: Oracle may stop VMs whose CPU p95 and network stay under 20 % for 7 days.
  The denominator of "CPU" is not documented for a 1/8-OCPU shape; to be calibrated with the first
  demo reset. A reclaimed VM is stopped (not deleted) per third-party reports; restarting needs the
  shape to be available and free accounts have no support requests. Mitigation: alert, a documented
  start command, backups outside the VM.
- Memory budget is tight (~140 MiB of margin before trimming the base system); Docker itself
  costs ~105–130 MiB. The fallback is more trimming (removing the Oracle agent snap loses its
  metrics), not a different runtime.
- Bastion access depends on the owner's changing home IP (allowlist per `/32`): runbook.
