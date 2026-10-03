# CPU calibration against Oracle's idle policy (phase 12, M7)

Oracle's documentation (checked 2026-10-03) says an Always Free compute instance is **idle**, and may be
reclaimed, when during a 7-day period **all** of these are true: CPU utilization at the 95th percentile
under 20 %, network utilization under 20 %, and (A1 shapes only) memory utilization under 20 %. It applies to
`VM.Standard.E2.1.Micro`, which has "1/8th of an OCPU with the ability to use additional CPU resources". The
documentation does not say what happens to a reclaimed VM nor whether you are warned, and it does not say
what the 20 % is relative to on a 1/8-OCPU shape.

The `CpuUtilization` metric (namespace `oci_computeagent`) is emitted by the **Compute Instance Monitoring**
plugin of Oracle Cloud Agent, the one plugin kept on the VM: it samples every 10 seconds and sends six
points a minute. So the question has a measurable part: **does the metric equal what the guest itself
measures, or is it scaled to the 1/8 allocation?** `deploy/bin/cpu-calibrate.sh` measures the guest side.

We never create artificial load to keep the VM "busy". This only tells us how real the risk is. Whatever the
answer, the plan stays: Healthchecks / UptimeRobot email you, you start the VM from the console, and the
backups in Object Storage cover the worst case (runbook sections 5, 7 and 10).

## 1. On the VM: 15 quiet minutes, then a busy window

Needs no root. It prints one line per minute (UTC).

```bash
/opt/smartops/current/bin/cpu-calibrate.sh 15
```

Write down the clock time (and your time zone) when you start. For a second run, do something real **in the
middle** of it, from your PC, and write down the minute:

```bash
node C:\dev\demo-check.mjs https://smartops-demo.duckdns.org      # six samples through the pipeline
```

(or press _Reset demo_ once in the panel: about 3 CPU-seconds).

## 2. In the Console: the same minutes

Observability & Management → Monitoring → _Metrics Explorer_ (or _Query editor_):

- Compartment `smartops`, namespace `oci_computeagent`, metric `CpuUtilization`, interval **1 minute**,
  statistic **Mean**, dimension `resourceId` = the VM's OCID, time range = your window (the Console shows your
  local time; the script prints UTC).
- In the query editor the same thing is:

```text
CpuUtilization[1m]{resourceId = "ocid1.instance.oc1.sa-saopaulo-1.xxxx"}.mean()
```

Put the two lists side by side, minute by minute:

| What you see                                           | It means                                                                                                                   |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Console ≈ the script's `busy%` (within a point or two) | the metric is the guest's own CPU time against the vCPU it sees; the 20 % bar is a fifth of that vCPU                      |
| Console ≈ 8 × `busy%` (capped at 100)                  | the metric is relative to the 1/8 allocation: the 20 % bar is only 2.5 % of the vCPU, and an idle demo may sit right at it |
| Console much lower, `steal%` high in the script        | the hypervisor is throttling the guest; the metric is not counting the stolen time                                         |

## 3. The number the policy uses

Oracle's bar is the p95 over 7 days. In the query editor, with the longest range the Console allows (the
VM exists since 2026-10-02, so a couple of days is what there is now):

```text
CpuUtilization[1d]{resourceId = "ocid1.instance.oc1.sa-saopaulo-1.xxxx"}.percentile(0.95)
```

`interval` accepts `1m`–`60m`, `1h`–`24h` and `1d`; if the Console refuses `1d` for your range, use `1h` and
take the highest value. For the network side, open `NetworksBytesIn` and `NetworksBytesOut` (they are bytes
per interval, not a percentage) over the same range.

Send me: the script's lines, the Console values for the same minutes (a screenshot is fine, hide nothing
secret: OCIDs are not secrets), and the p95 values. I will write the conclusion in the runbook (section 10) and
decide whether anything else is worth doing: for example, nothing, because the real VM is well above or well
below the bar, or a change to what the monitor reports.

Re-run it after a week of real life; the first days of a new VM are not representative.
