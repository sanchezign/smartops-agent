# Resolved or superseded Known issues

Moved textually from "Known issues" in CLAUDE.md on 2026-10-06: entries already resolved,
superseded or implemented. Open issues stay in CLAUDE.md.

- **Phase 12 — idle reclamation risk (open until the first deploy):** Oracle deems a VM idle when,
  over 7 days, CPU p95 AND network are < 20 % (memory only for A1). A micro can never exceed 12.5 %
  of one OCPU, so the denominator of "CPU utilization" is unknown (relative to the 1/8 allocation
  or never enforced). Measured in simulation: the light stack idles at 20.8 % of 1/8 OCPU. Calibrate
  on the real VM with the first demo reset (≈ 3 CPU-seconds) against the `CpuUtilization` metric.
  CALIBRATED 2026-10-04: the metric is the guest's busy% PLUS steal (not scaled to 1/8 OCPU); the quiet demo
  is at ~3 % busy, daily p95 6–8 % (13 % on the busiest day) → by the literal criterion it IS idle. The old
  rule "never artificial load" was REVERSED by the owner on 2026-10-04: a nightly keep-alive load (ADR-027,
  `docs/deploy/keepalive.md`), OFF by default, trial first. If reclaimed the VM is STOPPED (not deleted) per
  third-party reports: alert + start it from the Console (runbook §10 plan B); backups live off the VM.
- **Phase 6 (RESOLVED in phase 8 M4 for approvals made through the panel API):** approving a `column_mapping` review moves the run back to `classified`, but
  nothing re-triggers n8n: `extract` + `catalog/ingest` must be called again (done by hand
  in the M5 pass). The panel (phase 9) must re-trigger it (call the internal flow or emit a
  new event). The same applies to other approvals that send a run back to extraction.
- **Phase 6 (RESOLVED in phase 8 M1):** `internal_order` was not routed (the receiver sent it to "otro (fin)") —
  confirmed live during the phase 7 phone test ("necesito 3 macetas" → classified, no
  notification, a real order would be lost). Promoted to a REQUIRED BEFORE PRODUCTION
  first sub-step of phase 8 (see Phase order) — not just a known issue anymore.
- **Phase 6:** the WhatsApp digest text is terse — richer content planned in phase 9 (see
  Phase order).
- **Phase 5 golden review (2026-09-25):** the classifier labeled the short text "Lista
  septiembre: tornillo 6mm 12 UYU, tuerca 6mm 5 UYU" as `price_list_full` (0.65) although
  the prompt requires an explicit signal. RESOLVED in phase 6: n8n never decides full vs
  partial; the backend uses the extraction's `listKind` (static test + ADR-015).
- Opt-in (ADR-009): opt-out ("STOP", "BAJA") is not implemented yet — it is a
  REQUIRED part of phase 7 (see Phase order). A manual opt-in does not record who
  confirmed it (needed before the panel, phase 9).
- Demo mode: `fake` providers (Graph API, transcription, LLM in phase 5) are rejected
  in production. The $0 public demo (phase 12) must decide how to run without a Meta
  account (e.g. an explicit DEMO_MODE that allows fakes and shows a banner).
- **Phase 12 — at the phase close:** delete the local test images `smartops-local/smartops-{api,admin}:m0a|m0b`
  (user, 2026-09-28). RESOLVED 2026-10-06: they (and the `smartops-m2light_*` / `smartops-m2full_*` harness volumes)
  do not exist on the new laptop (migrated 2026-10-05); nothing to delete.
