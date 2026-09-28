// Invariants of the public demo's compose file (phase 12, ADR-023), checked on the output of
// `docker compose config --format json` (stdin) — the resolved file, exactly as it would run.
// Any change that exposes Postgres / n8n, gives n8n its editor or internet, drops a digest pin
// or brings a real provider into the demo fails CI.
import { readFileSync } from "node:fs";

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

// Postgres and n8n live on the internal network only (no internet, not reachable from Caddy).
const internal = config.networks?.backend?.internal === true;
if (!internal) fail("the backend network must be internal");
for (const name of ["postgres", "n8n", "worker"]) {
  const nets = Object.keys(services[name]?.networks ?? {});
  if (nets.join(",") !== "backend")
    fail(`${name} must be on the backend network only (got ${nets})`);
}

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

// The public demo: fakes only, no real key variable at all, no admin account.
for (const name of ["api", "worker", "seed"]) {
  const env = services[name]?.environment ?? {};
  if (env.DEMO_MODE !== "true") fail(`${name}: DEMO_MODE must be true`);
  if (env.AI_PROVIDER !== "fake" || env.TRANSCRIPTION_PROVIDER !== "fake")
    fail(`${name}: the demo runs the fake LLM and transcriber`);
  for (const key of ["ANTHROPIC_API_KEY", "TRANSCRIPTION_API_KEY", "DEMO_ADMIN_PASSWORD"]) {
    if (key in env) fail(`${name}: ${key} must not be passed to the public demo`);
  }
  if (env.TRUST_PROXY !== "1") fail(`${name}: TRUST_PROXY must be 1 (one hop: Caddy)`);
}

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
  process.stderr.write(`deploy/compose.yaml invariants:\n  - ${problems.join("\n  - ")}\n`);
  process.exit(1);
}
process.stdout.write(
  `OK: deploy/compose.yaml invariants (${Object.keys(services).length} services)\n`,
);
