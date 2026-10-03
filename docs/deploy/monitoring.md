# Monitoring and abuse checks, step by step (phase 12, M6)

Two free services watch the demo from two sides:

| Service                                | Looks from… | Tells you when…                                                                    |
| -------------------------------------- | ----------- | ---------------------------------------------------------------------------------- |
| **UptimeRobot** (free)                 | outside     | the public URL does not answer (DNS, TLS, firewall, Caddy, the panel, the API)     |
| **Healthchecks.io** (free, "Hobbyist") | inside      | the VM's own jobs stop or fail: health check, boot, backup, and your two reminders |

Limits checked on their pricing pages on 2026-10-03: UptimeRobot free = 50 monitors, 5-minute interval,
HTTP / keyword / ping monitors, 5 alert integrations, for "hobby and non-profit" use (keep it to this
portfolio demo; do not use it to monitor a paying client's system, buy a plan for that). Healthchecks
free = 20 checks, 100 log entries per check, email alerts. Both stay inside the $0 rule: no card.

## 1. Healthchecks.io: the five checks (your browser)

1. Create an account at healthchecks.io (email + password; the alerts go to that email) and a project
   named `smartops-demo`.
2. Create these five checks (_Add Check_, **Simple** schedule). Name, **Period**, **Grace Time**:

| Name                    | Period    | Grace   | Who pings it                                                |
| ----------------------- | --------- | ------- | ----------------------------------------------------------- |
| `smartops-monitor`      | 5 minutes | 10 min  | the VM's health timer, every 5 minutes                      |
| `smartops-boot`         | 365 days  | 7 days  | the VM after a reboot; **it matters when it FAILS** (below) |
| `smartops-backup`       | 1 day     | 3 hours | the daily backup (03:30) and the pre-deploy backups         |
| `smartops-restore-test` | 30 days   | 5 days  | you, after each restore test on your PC                     |
| `smartops-ghcr-token`   | 60 days   | 5 days  | you, every time you rotate the GHCR token                   |

- The boot check is not periodic (the VM only reboots when an update needs it), so its period is the
  longest the form allows; use what the form accepts if 365 days is too long. What you want from it is
  the **failure** email: the VM rebooted and the containers did not come back.
- The GHCR token expires on 2026-12-31 and the runbook says to renew it by 2026-12-15. The check is
  60 days + 5 days of grace from the day you ping it, so on a ping made around 2026-10-03 the email
  arrives about 2026-12-07. (The older runbook text said 85 days: that would only warn on the
  expiry day itself.)

3. Open each check and copy its **ping URL** (`https://hc-ping.com/<uuid>`). Anyone who has the URL can
   fake a ping: treat it like a password, never paste it in a chat or commit it.
4. A new check never alerts until its first ping, so arm the two reminders now from your PC:

```bash
curl -fsS "<ping URL of smartops-ghcr-token>"            # the token was created on 2026-10-02
curl -fsS "<ping URL of smartops-restore-test>"          # you ran a passing restore test on 2026-10-03
```

The other three arm themselves with the first real ping from the VM (steps 3 and 4). 5. _Integrations_: the email is already there. Add nothing else (it costs nothing but nobody needs it).

## 2. On the VM: connect the URLs

> `hc-test.sh` ships in the release after 0.13.0. Deploy it first (runbook section 1), then continue.

Connect with `scripts\oci\bastion-connect.ps1` ([guide](bastion-access.md)). On the VM, **type the URLs
when asked** (they are not echoed and stay out of the shell history):

```bash
# The health timer and the boot check: /etc/smartops/monitor.env (it does not exist yet)
sudo test ! -e /etc/smartops/monitor.env || echo "monitor.env already exists: edit it with sudo nano instead"
read -r -s -p "Ping URL of smartops-monitor: " HC1; echo
read -r -s -p "Ping URL of smartops-boot: " HC2; echo
printf 'HC_MONITOR_URL=%s\nHC_BOOT_URL=%s\n' "$HC1" "$HC2" | sudo tee /etc/smartops/monitor.env >/dev/null
sudo chown root:root /etc/smartops/monitor.env && sudo chmod 600 /etc/smartops/monitor.env
unset HC1 HC2

# The backup check: one line of backup.env
read -r -s -p "Ping URL of smartops-backup: " HC3; echo
sudo sed -i '/^HC_BACKUP_URL=/d' /etc/smartops/backup.env
printf 'HC_BACKUP_URL=%s\n' "$HC3" | sudo tee -a /etc/smartops/backup.env >/dev/null
unset HC3
```

Defaults you may leave alone: `DISK_MAX_PCT=85`, and memory alerts below 100 MB available in the light
profile. (The last real backup measured 498 MB available at its lowest.)

Start the health timer (it is installed by every deploy but only enabled once `monitor.env` exists):

```bash
sudo /opt/smartops/current/bin/install-units.sh
systemctl list-timers 'smartops*'                   # smartops-monitor.timer must be listed
sudo systemctl start smartops-monitor.service       # the first health ping now, not in 5 minutes
sudo /opt/smartops/current/bin/hc-test.sh           # a harmless "/log" ping to each check
```

Expected: `PASS` for `monitor`, `boot` and `backup`, then `HC TEST PASSED (3 checked)`. A wrong UUID
shows `FAIL … does not exist` (Healthchecks answers 200 even then; the script reads the body). The
script never prints the URLs.

The `smartops-monitor` check turns green with that first ping and then every 5 minutes by itself. Run a
backup to arm the third:

```bash
sudo /opt/smartops/current/bin/backup.sh --reason manual
```

## 3. Prove that the alerts really reach you

Do this once, now, so you know the emails work before you need them.

1. **Failure email, one check at a time** (the check turns red and an email arrives; the next real run turns
   it green):

```bash
sudo /opt/smartops/current/bin/hc-test.sh --fail monitor      # then: sudo systemctl start smartops-monitor.service
sudo /opt/smartops/current/bin/hc-test.sh --fail boot         # then: sudo systemctl start smartops-boot-check.service
sudo /opt/smartops/current/bin/hc-test.sh --fail backup       # then: sudo /opt/smartops/current/bin/backup.sh --reason manual
```

2. **A real fault (optional, 10 minutes)**: stop the panel container, see both services notice, start it
   again.

```bash
sudo docker stop smartops-demo-admin-1
# within 5 minutes: the monitor check turns red ("containers: admin(exited/)") and, from outside, the
# UptimeRobot "login page" monitor (step 4) goes down.
sudo docker start smartops-demo-admin-1
sudo systemctl start smartops-monitor.service            # turns the monitor green without waiting
```

## 4. UptimeRobot: two monitors (your browser)

1. Create an account at uptimerobot.com (the free plan, no card).
2. _Add New Monitor_ (alerts: your email, the default contact):

| Type    | Name              | URL / keyword                                                                                   | Interval |
| ------- | ----------------- | ----------------------------------------------------------------------------------------------- | -------- |
| HTTP(s) | `demo health`     | `https://smartops-demo.duckdns.org/api/v1/health`                                               | 5 min    |
| Keyword | `demo login page` | `https://smartops-demo.duckdns.org/login`, keyword `SmartOps`, alert when it **does not exist** | 5 min    |

The health endpoint answers 200 only when the database is up (503 otherwise), so the first monitor
covers DNS, the certificate, Caddy, the API and Postgres; the second covers the panel. 3. Do not add a status page or other contacts. Free monitors check from outside only; they do not make the VM
"busy" (see runbook section 10, Oracle's idle policy).

## 5. Bounded abuse and load check (from your PC)

Run it **once**, when you do not need the demo yourself, with every panel tab closed (open event
streams count against the per-IP cap):

```bash
node scripts/deploy/demo-abuse-check.mjs https://smartops-demo.duckdns.org --inject-burst
```

What it does, with a hard cap on every step (about 600 requests in total): the private surface answers
401/404 (admin, internal, webhook routes) and a 2 MB body gets 413; a burst of 100 health requests, ten at
a time, must answer 200 with p95 under 3 s; the sixth event stream from one IP is refused; the shared
account cannot "sign out everywhere"; the global per-IP limit answers `429` with `Retry-After`; the login
limit still answers `429` when the client changes `X-Forwarded-For` on every attempt; and with
`--inject-burst` the per-IP sample cap answers `429` and the one-at-a-time queue drains.

Side effects you should expect, all temporary: your IP waits up to a minute (the script waits), cannot
log in to the demo for up to 15 minutes (add `--skip-login-limit` to avoid that part), and cannot send
samples for up to 10 minutes. If the login step says it got a `429` on the very first attempt, your IP was
already limited: wait 15 minutes and run it again.

In a second terminal on the VM, while it runs, look at what the VM feels:

```bash
free -m
sudo docker stats --no-stream
sudo /opt/smartops/current/bin/status.sh
```

Send me the script's last lines and those three outputs taken right after the burst. This is also the
first real measurement of how much CPU a visitor can cost on a 1/8 OCPU VM.
