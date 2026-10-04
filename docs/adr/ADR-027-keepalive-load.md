# ADR-027: A nightly keep-alive CPU load so the demo VM does not look idle to Oracle

Date: 2026-10-04
Status: accepted (the owner's decision, 2026-10-04). Reverses the earlier rule "we never create artificial load".

## Context

The public demo runs on an Always Free `VM.Standard.E2.1.Micro` (ADR-023). Oracle's documentation says:
"Idle Always Free compute instances may be reclaimed by Oracle. Oracle will deem virtual machine and bare
metal compute instances as idle if, during a 7-day period, the following are true: CPU utilization for the
95th percentile is less than 20%; Network utilization is less than 20%; Memory utilization is less than 20%
(applies to A1 shapes only)" — [Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
(also under the older address [resourceref.htm](https://docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm)),
read on 2026-10-03/04. It applies to the E2.1.Micro and A1.Flex.

What the documentation does **not** say: that every condition is mandatory (the wording is "the following are
true", which reads as a conjunction), the granularity of the p95, whether it applies during a Free Trial, what
happens to the instance, or whether you get a warning. Third-party reports of Oracle's own e-mail
([51sec.org, 2023](https://blog.51sec.org/2023/02/oracle-cloud-cleaning-up-idle-compute.html)) say instances are
**stopped, not deleted**, with one week's notice, restartable "as long as the associated compute shape is
available", and that moving to Pay As You Go avoids it; the same source shows the threshold was 10 %, then 15 %,
and is 20 % today, so it changes. Nothing found, official or not, says whether a keep-alive load is allowed or
forbidden.

Measured on the real VM (2026-10-04, `cpu-calibrate.sh` vs the Console, see `docs/deploy/cpu-calibration.md`):
the `CpuUtilization` metric is the guest's own busy% **plus steal**, not scaled to the 1/8 OCPU; the quiet demo
sits at 3.2 % busy (p95 4.9 %); daily p95 points of the metric: ~2 %, ~13 % on a day with four deploys and all
the tests, a normal day ~6–8 %. Network is far below any share of 480 Mbps. By the literal criterion the demo
is idle.

Pay As You Go was discarded earlier (a US$100 hold, no capacity guarantee, ADR-023).

## Decision

A systemd timer runs one CPU-bound process for up to 2 hours a night so the p95 of the metric stays above 20 %:

- `smartops-keepalive.timer`: `03:00:00 UTC` (00:00 in Montevideo), `RandomizedDelaySec=5min`,
  `Persistent=false`. Everything in UTC on purpose: the apt timers (02:20 / 02:50 local = 05:20 / 05:50 UTC),
  the backup (03:30 local = 06:30 UTC) and the reboot (04:00 local = 07:00 UTC) are Montevideo time. The longest
  run ends at 05:05 UTC; a test keeps it at least 10 minutes before the first apt timer.
- `smartops-keepalive.service`: `timeout <minutes>m sha256sum /dev/zero`, `Nice=19`, `CPUSchedulingPolicy=idle`,
  `IOSchedulingClass=idle`, `CPUQuota=35%`, `MemoryMax=32M`; no network (`PrivateNetwork`), no files
  (`ProtectSystem=strict`, `/opt`, `/etc/smartops` and Docker inaccessible), a dynamic user, no capabilities.
- **Off by default.** `/etc/smartops/keepalive.env` (`KEEPALIVE_LOAD=on|off`, `KEEPALIVE_MINUTES` 1–120) is read
  every time the unit starts; `deploy/bin/keepalive.sh on|off|status|test|stop` edits it. A 20-minute trial
  (`keepalive.sh test`) decides whether the quota stays at 35 % before it is turned on.
- The monitor shows `keepalive off|on|on, running now` in its summary and has no CPU threshold: it can never
  report the load as a problem.
- 35 % × 120 min gives 8.3 % of the day's samples above 20 % (the p95 needs 5 %), a margin of 1.7×. It is
  robust to a p95 over minutes, over hours (2 of 24 hourly points) or over days (each day's own p95).

## Consequences

- The VM does real, useless work for two hours a night. It uses no network, no disk and about 1 MB of memory.
- Inside the guest the demo always wins (SCHED_IDLE), but the hypervisor shares the same 1/8 OCPU: the load can
  raise steal and slow the demo while it runs. That is measured before turning it on (the 20-minute trial) and
  the quota can be lowered with a drop-in (`CPUQuota=25%` still gives ~28–30 % on the metric).
- Plan B stays whatever the load does (runbook section 10): Healthchecks / UptimeRobot alert, start the VM
  from the Console, verify, restore from the backup if it was deleted.
- If Oracle ever forbids artificial load, `keepalive.sh off` turns it off at once.
- Verified under a real systemd 255 (Ubuntu 24.04's version) in a container: skipped quietly when off or when
  the minutes are invalid; with it on the process is SCHED_IDLE, has only a loopback interface, `/dev/zero` is
  readable under `PrivateDevices` + `ProtectSystem=strict`, the root is read-only, and 21 CPU-seconds were
  consumed in 60 s (= the 35 % quota). What a container cannot show is the hypervisor's steal on the real VM.
