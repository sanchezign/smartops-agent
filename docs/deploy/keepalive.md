# The keep-alive load: trial, activation and plan B (phase 12, ADR-027)

Why it exists, what it does and what it cannot do: [ADR-027](../adr/ADR-027-keepalive-load.md). In one line:
a process at the lowest priority, no network and no disk, at most 50 % of one vCPU (about 25 % on the Console metric), for up to 2 hours a night
(03:00 UTC = 00:00 in Montevideo), so Oracle's idle test (CPU p95 < 20 % over 7 days) does not match the demo.
It is **off** until you turn it on (section 2). On the real VM it has been **on** since 2026-10-05.

## 0. How the number is chosen: the Console averages the vCPUs

`CPUQuota` is a share of **one** vCPU, but the Console's `CpuUtilization` averages **all** the vCPUs the guest sees
(`nproc` = 2 on this E2.1.Micro). So:

```
Console plateau ≈ rest + CPUQuota / nproc + a little steal        (rest ≈ 5–7 %, steal ≈ 2 points)
```

Evidence (Console, Metrics Explorer, `CpuUtilization` 1-minute mean, UTC, measured by the owner):

| Date       | Quota | What                                                                                    |
| ---------- | ----- | --------------------------------------------------------------------------------------- |
| 2026-10-05 | 35 %  | rest ~5–7 %; keep-alive 03:00–05:00 plateau ~23–28 % (peaks 30–33 %); back to ~5 %      |
| 2026-10-05 | 35 %  | the apt timers at ~05:23 peak at ~57 %: normal, not the load                            |
| daily p95  | —     | 10-02 ~2.6 %, 10-03 ~12.8 %, 10-04 ~15.8 %, **10-05 ~24.7 %** (first day with the load) |

The model fits: 6 + 35/2 + 2 = 25.5 %. The daily p95 follows the plateau because the 2 hours are 8.3 % of the day's
samples and the p95 needs only 5 %, so the 95th percentile sits inside the plateau: 24.7 % was a margin of only
~5 points over Oracle's 20 % bar (and the bar has moved before, ADR-027). Predictions for other quotas:

| CPUQuota | Plateau on the Console (rest 6 %) | Margin over 20 % |
| -------- | --------------------------------- | ---------------- |
| 35 %     | 23–28 % (measured)                | ~5 points        |
| 40 %     | ~28 %                             | ~8 points        |
| **50 %** | **~33 %** (the value now)         | **~13 points**   |
| 60 %     | ~38 %                             | ~18 points       |

**Trial with 50 % on the real VM (2026-10-06, 20:53–21:13 UTC, owner's measurements):**

| What                           | At rest                   | With the load (50 %)                                      |
| ------------------------------ | ------------------------- | --------------------------------------------------------- |
| Recorder busy / steal          | busy ~2.7 %, steal ~3.5 % | busy ~22.7 %, steal ~9–13 % (one peak of 26.3 % at 20:58) |
| Console plateau (busy + steal) | ~6 %                      | **~33–35 %** (predicted 30–36 %: the model holds)         |
| `demo-check` slowest sample    | 2.3–5.3 s                 | 9.9 s (all samples `ends as …`)                           |
| 100 health requests, p95       | 391 ms                    | 538 ms                                                    |

Steal rose by 6–10 points with the load (the unknown below): it counts on the metric, and the demo stayed inside the
gate (slowest sample 9.9 s against the 16 s limit, health p95 538 ms against 1 s).

50 % was chosen over 55–60 % because a bigger share asks the hypervisor for more of a 1/8 OCPU: **steal** is the unknown
(at rest it is 2.5–6.8 %, and the metric counts it, so steal helps the number but can slow the demo). The load runs at
idle priority inside the guest, so the demo wins there; it can still lose time to the hypervisor. The trial in
section 1 measures it before the nightly run is relied on.

## 1. The 20-minute trial (decides whether 50 % stays)

Baseline you measured on 2026-10-04: busy 3.2 % (p95 4.9 %), steal 2.5–6.8 %, 100 health requests p95 294 ms,
demo samples 2.8–8.2 s. Do the trial in a quiet moment.

**1. On the VM** (through `bastion-connect.ps1`), start the recorder first, in the background so a dropped
connection does not stop it:

```bash
nohup sudo /opt/smartops/current/bin/cpu-calibrate.sh 25 > /tmp/ka-trial.txt 2>&1 &
sleep 120        # two minutes of "before"
sudo /opt/smartops/current/bin/keepalive.sh test 20
```

`keepalive.sh test 20` starts the load for 20 minutes and puts your saved settings back at once: if the keep-alive
was **on** it stays on, if it was off it stays off (it never changes the switch). If a run is already in progress it
does nothing and says so (`a run is already in progress; wait for it or stop it first: keepalive.sh stop`): the
unit is a oneshot, so starting it again would be ignored silently.
The recorder keeps going for 25 minutes: 2 before, 20 with the load, the rest after.

**2. From your PC, about 10 minutes after the load started**, with the panel tabs closed:

```bash
node scripts/deploy/demo-check.mjs https://smartops-demo.duckdns.org
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

| What                                     | Expected                                                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Console `CpuUtilization` during the load | about **30–36 %** (rest 5–7 % + 50 % / 2 vCPUs + a little steal)                                                            |
| `busy%` and `steal%` in the recorder     | `busy` about 28–30 % (the recorder averages the 2 vCPUs too); `steal` may rise: that is the hypervisor sharing the 1/8 OCPU |
| Demo samples (`demo-check`)              | all `ends as …` lines pass                                                                                                  |
| 100 health requests (`abuse-check`)      | p95 **under 1 s**                                                                                                           |
| Healthchecks "monitor"                   | stays green (a ping every 5 minutes, with `keepalive on, running now`)                                                      |

**Decision gate** (all four must hold to keep 50 %):

1. every demo sample finishes and the slowest takes **no more than 2 × the baseline** (about 16 s);
2. the 100-request burst has p95 **under 1 s**;
3. no alert from UptimeRobot or Healthchecks during the 20 minutes;
4. the Console plateau is at least **30 %** (otherwise the quota is not doing what the formula says: tell me the numbers).

If it fails, lower the quota and repeat the trial once:

```bash
sudo systemctl edit smartops-keepalive.service     # add:  [Service]  CPUQuota=40%   → save
```

At 40 % the metric reads about 28 % (~8 points of margin). **Do not go below 40 %**: at 25 % the plateau would be ~20 %, exactly the bar. If it fails again, leave it **off** and
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
   still attached (`smartops-demo.duckdns.org` resolves to the reserved IP shown in Networking → Reserved public IPs); through the Bastion:
   `sudo /opt/smartops/current/bin/status.sh` (version, containers healthy, timers listed) and
   `sudo /opt/smartops/current/bin/keepalive.sh status`; `node scripts/deploy/demo-check.mjs https://smartops-demo.duckdns.org`.
4. The UptimeRobot monitors and the Healthchecks `smartops-monitor` check turn green on their own.
5. If the instance was **terminated** instead: runbook section 5 (a new VM, the backups are in Object Storage).
6. Afterwards read the Console's `CpuUtilization` p95 for the last 7 days. If the load was on and Oracle stopped
   it anyway, the policy is measuring something else (the network, or a different way of computing the p95):
   send me the numbers before changing anything.
