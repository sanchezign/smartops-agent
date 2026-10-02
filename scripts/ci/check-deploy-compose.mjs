// Invariants of the public demo's compose files (phase 12, ADR-023 / ADR-025), checked on the
// output of `docker compose config --format json` (stdin) — the resolved file, exactly as it
// would run:   node check-deploy-compose.mjs [full|light]
// Any change that exposes Postgres / n8n, gives n8n its editor or internet, drops a digest pin,
// brings a real provider into the demo or lets the light profile outgrow a 1 GB machine fails CI.
import { readFileSync } from "node:fs";

const profile = process.argv[2] ?? "full";
if (!["full", "light"].includes(profile)) {
  process.stderr.write("usage: check-deploy-compose.mjs [full|light]\n");
  process.exit(2);
}
const light = profile === "light";
const file = light ? "deploy/compose.light.yaml" : "deploy/compose.yaml";
const config = JSON.parse(readFileSync(0, "utf8"));
const services = config.services ?? {};
const problems = [];
const fail = (msg) => problems.push(msg);

// Only Caddy publishes ports, and only 80/443.
for (const [name, svc] of Object.entries(services)) {
  const ports = svc.ports ?? [];
  if (name !== "caddy" && ports.length > 0) fail(`${name} publishes ports (only caddy may)`);
  if (name === "caddy") {
    const published = ports.map((p) => String(p.target)).sort();
    if (published.join(",") !== "443,80")
      fail(`caddy must publish exactly 80 and 443 (got ${published})`);
  }
}

// Postgres (and n8n, worker) live on the internal network only (no internet, not reachable from Caddy).
const internal = config.networks?.backend?.internal === true;
if (!internal) fail("the backend network must be internal");
const backendOnly = light ? ["postgres"] : ["postgres", "n8n", "worker"];
for (const name of backendOnly) {
  const nets = Object.keys(services[name]?.networks ?? {});
  if (nets.join(",") !== "backend")
    fail(`${name} must be on the backend network only (got ${nets})`);
}

if (light) {
  // ADR-025: no n8n, no separate worker; API + worker + orchestrator are one process.
  for (const name of ["n8n", "worker"])
    if (name in services) fail(`the light profile has no ${name} service`);
  const api = services.api ?? {};
  if (!(api.command ?? []).includes("dist/demo-server.js"))
    fail("api must run dist/demo-server.js (API + worker + orchestrator in one process)");
  if (api.environment?.DEMO_ORCHESTRATOR !== "internal")
    fail("api: DEMO_ORCHESTRATOR must be internal");
  const apiNets = Object.keys(api.networks ?? {}).sort();
  if (apiNets.join(",") !== "backend,edge")
    fail(`api must be on edge and backend (got ${apiNets})`);
  if (!(services.postgres?.command ?? []).includes("shared_buffers=32MB"))
    fail("postgres must keep its small-memory tuning (shared_buffers=32MB)");
  for (const key of Object.keys(api.environment ?? {})) {
    if (/^N8N_(WEBHOOK_SECRET|RECEIVER_WEBHOOK_URL|ENCRYPTION_KEY|DB_PASSWORD)$/.test(key))
      fail(`api: ${key} makes no sense without n8n`);
  }
  // Every long-running service has a memory cap and together they fit a 1 GB machine.
  const MiB = 1024 * 1024;
  let total = 0;
  for (const [name, svc] of Object.entries(services)) {
    if ((svc.profiles ?? []).includes("tools")) continue;
    if (!svc.mem_limit)
      fail(`${name}: mem_limit missing (a 1 GB machine needs a ceiling per service)`);
    total += Number(svc.mem_limit ?? 0);
  }
  if (total > 768 * MiB)
    fail(
      `the memory caps add up to ${Math.round(total / MiB)} MiB (limit 768 MiB for a 1 GB machine)`,
    );
} else {
  // n8n: no editor, no telemetry, no public API (user addendum D).
  const n8nEnv = services.n8n?.environment ?? {};
  for (const [key, value] of Object.entries({
    N8N_DISABLE_UI: "true",
    N8N_DIAGNOSTICS_ENABLED: "false",
    N8N_VERSION_NOTIFICATIONS_ENABLED: "false",
    N8N_TEMPLATES_ENABLED: "false",
    N8N_PUBLIC_API_DISABLED: "true",
  })) {
    if (String(n8nEnv[key]) !== value) fail(`n8n: ${key} must be ${value}`);
  }
}

// The public demo: fakes only, no real key variable at all, no admin account.
for (const name of light ? ["api", "seed"] : ["api", "worker", "seed"]) {
  const env = services[name]?.environment ?? {};
  if (env.DEMO_MODE !== "true") fail(`${name}: DEMO_MODE must be true`);
  if (env.AI_PROVIDER !== "fake" || env.TRANSCRIPTION_PROVIDER !== "fake")
    fail(`${name}: the demo runs the fake LLM and transcriber`);
  for (const key of ["ANTHROPIC_API_KEY", "TRANSCRIPTION_API_KEY", "DEMO_ADMIN_PASSWORD"]) {
    if (key in env) fail(`${name}: ${key} must not be passed to the public demo`);
  }
  if (env.TRUST_PROXY !== "1") fail(`${name}: TRUST_PROXY must be 1 (one hop: Caddy)`);
}

// Phase 13: the public demo opens in English.
if (services.admin?.environment?.PANEL_DEFAULT_LOCALE !== "en")
  fail("admin: PANEL_DEFAULT_LOCALE must be en (the public demo starts in English)");

// Third-party images pinned by digest; ours by version tag (the release workflow's tags).
for (const [name, svc] of Object.entries(services)) {
  const image = String(svc.image ?? "");
  const ours = /\/smartops-(api|admin):/.test(image);
  if (!ours && !/@sha256:[0-9a-f]{64}$/.test(image))
    fail(`${name}: third-party image not pinned by digest (${image})`);
  if (!svc.security_opt?.includes("no-new-privileges:true"))
    fail(`${name}: no-new-privileges missing`);
}

if (problems.length > 0) {
  process.stderr.write(`${file} invariants:\n  - ${problems.join("\n  - ")}\n`);
  process.exit(1);
}
process.stdout.write(`OK: ${file} invariants (${Object.keys(services).length} services)\n`);
