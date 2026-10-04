# The keep-alive load: trial, activation and plan B (phase 12, ADR-027)

Why it exists, what it does and what it cannot do: [ADR-027](../adr/ADR-027-keepalive-load.md). In one line:
a process at the lowest priority, no network and no disk, at most 35 % of one vCPU, for up to 2 hours a night
(03:00 UTC = 00:00 in Montevideo), so Oracle's idle test (CPU p95 < 20 % over 7 days) does not match the demo.
It is **off** until you turn it on. The VM exists since 2026-10-02: turn it on **before 2026-10-09**.

## 1. The 20-minute trial (decides whether 35 % stays)

Baseline you measured on 2026-10-04: busy 3.2 % (p95 4.9 %), steal 2.5–6.8 %, 100 health requests p95 294 ms,
demo samples 2.8–8.2 s. Do the trial in a quiet moment.

**1. On the VM** (through `bastion-connect.ps1`), start the recorder first, in the background so a dropped
connection does not stop it:

```bash
nohup sudo /opt/smartops/current/bin/cpu-calibrate.sh 25 > /tmp/ka-trial.txt 2>&1 &
sleep 120        # two minutes of "before"
sudo /opt/smartops/current/bin/keepalive.sh test 20
```

`keepalive.sh test 20` starts the load for 20 minutes and puts your saved settings back at once (it stays off).
The recorder keeps going for 25 minutes: 2 before, 20 with the load, the rest after.

**2. From your PC, about 10 minutes after the load started**, with the panel tabs closed:

```bash
node C:\dev\demo-check.mjs https://smartops-demo.duckdns.org
node scripts/deploy/demo-abuse-check.mjs https://smartops-demo.duckdns.org --skip-login-limit
```

(the second one only for its "100 health requests" line: p50 / p95 / max).

**3. After 25 minutes, on the VM:**

```bash
cat /tmp/ka-trial.txt
sudo /opt/smartops/current/bin/status.sh
```

**4. In the Console** (Observability & Management → Monitoring → Metrics Explorer; compartment `smartops`,
namespace `oci_computeagent`, metric `CpuUtilization`, interval 1 minute, statistic Mean, dimension `resourceId`
= the VM's OCID): the same 25 minutes. Details in [cpu-calibration.md](cpu-calibration.md).

**What to look at**

| What                                     | Expected                                                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| Console `CpuUtilization` during the load | about 35–45 % (35 % of a vCPU plus the demo's own 3–5 %)                            |
| `busy%` and `steal%` in the recorder     | `busy` close to 35 %; `steal` may rise: that is the hypervisor sharing the 1/8 OCPU |
| Demo samples (`demo-check`)              | all `ends as …` lines pass                                                          |
| 100 health requests (`abuse-check`)      | p95 **under 1 s**                                                                   |
| Healthchecks "monitor"                   | stays green (a ping every 5 minutes, with `keepalive on, running now`)              |

**Decision gate** (all three must hold to keep 35 %):

1. every demo sample finishes and the slowest takes **no more than 2 × the baseline** (about 16 s);
2. the 100-request burst has p95 **under 1 s**;
3. no alert from UptimeRobot or Healthchecks during the 20 minutes.

If it fails, lower the quota and repeat the trial once:

```bash
sudo systemctl edit smartops-keepalive.service     # add:  [Service]  CPUQuota=25%   → save
```

At 25 % the metric still reads about 28–30 %, enough for a 2-hour block. If it fails again, leave it **off** and
rely on plan B (section 4); tell me the numbers.

## 2. Turn it on

```bash
sudo /opt/smartops/current/bin/keepalive.sh on          # 120 minutes every night; keepalive.sh on 90 for less
sudo /opt/smartops/current/bin/keepalive.sh status      # the next run: 03:00 UTC (up to 5 minutes later)
```

The monitor's ping now says `keepalive on`. **The morning after the first night**, check in the Console that
`CpuUtilization[1d]{resourceId = "…"}.percentile(0.95)` for that day is well above 20 %. A week later the 7-day
number is what Oracle looks at.

## 3. Turn it off

```bash
sudo /opt/smartops/current/bin/keepalive.sh off         # at once; also stops a run in progress
sudo /opt/smartops/current/bin/keepalive.sh stop        # only stops a run in progress
```

If Oracle ever forbids artificial load, `off` is all it takes; the unit stays installed but does nothing.

## 4. Plan B: Oracle stopped the VM (with the load on or off)

You will know from Oracle's e-mail (reports say one week's notice) or from UptimeRobot / Healthchecks (no pings).

1. Console → Compute → Instances → `smartops-demo-micro`. If the state is **Stopped**: _Start_. If the start
   fails for lack of capacity, try again later; that shape is rarely short.
2. Wait about 3 minutes. The boot check pings Healthchecks (`smartops-boot`), the containers come back by
   themselves (`restart: unless-stopped`).
3. Verify: `https://smartops-demo.duckdns.org/api/v1/health` answers 200 and the panel loads; the reserved IP is
   still attached (`smartops-demo.duckdns.org` resolves to `163.176.132.161`); through the Bastion:
   `sudo /opt/smartops/current/bin/status.sh` (version, containers healthy, timers listed) and
   `sudo /opt/smartops/current/bin/keepalive.sh status`; `node C:\dev\demo-check.mjs https://smartops-demo.duckdns.org`.
4. The UptimeRobot monitors and the Healthchecks `smartops-monitor` check turn green on their own.
5. If the instance was **terminated** instead: runbook section 5 (a new VM, the backups are in Object Storage).
6. Afterwards read the Console's `CpuUtilization` p95 for the last 7 days. If the load was on and Oracle stopped
   it anyway, the policy is measuring something else (the network, or a different way of computing the p95):
   send me the numbers before changing anything.
