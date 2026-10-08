// Checks the PUBLIC demo from your PC (phase 12 M4, moved into the repo in phase 14):
//
//   node scripts/deploy/demo-check.mjs https://smartops-demo.duckdns.org
//   node scripts/deploy/demo-check.mjs https://… --content=es     (a deployment seeded in Spanish)
//   node scripts/deploy/demo-check.mjs http://127.0.0.1:4100       (a local DEMO_MODE API: edge checks skipped)
//
// 1) health, TLS, HSTS and blocked internal routes, 2) the public operator signs in (the credentials
// the login screen shows: demo@smartops.test), 3) the demo content is the language the deployment says
// (DEMO_CONTENT_LANGUAGE: English suppliers by default), 4) SSE first frame (GET and POST) through
// Caddy, 5) the six "Try the system" samples through the real pipeline, each with the time it took and
// its expected final state.
// Uses only the public operator the login screen already shows. Touches nothing else.
const args = process.argv.slice(2);
const base = (args.find((a) => !a.startsWith("--")) ?? "").replace(/\/+$/, "");
const content = (args.find((a) => a.startsWith("--content="))?.split("=")[1] ?? "en").toLowerCase();
const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base);
if ((!/^https:\/\//.test(base) && !local) || !["en", "es"].includes(content)) {
  console.error("usage: node demo-check.mjs https://<your-demo-host> [--content=en|es]");
  process.exit(2);
}
const api = `${base}/api/v1`;
const FINAL = new Set(["ingested", "needs_review", "failed", "rejected"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failures += 1;
};

/** What each demo language must show (suppliers of the seed) — keep in sync with content/{en,es}.ts. */
const EXPECTED_SUPPLIERS = {
  en: ["Corvane Fasteners Inc.", "Tessaly Paint & Coatings", "Norvale Electric Supply Ltd."],
  es: ["Distribuidora Norte", "Pinturas del Sur", "Eléctrica Oriental"],
};
/**
 * The six samples and the state each one ends in: the new spreadsheet format and the injection wait
 * for a person (needs_review); everything else is read and applied (ingested).
 */
const SAMPLES = [
  ["foto", "ingested"],
  ["pdf", "ingested"],
  ["audio", "ingested"],
  ["planilla", "ingested"],
  ["planilla_nueva", "needs_review"],
  ["injection", "needs_review"],
];

// 1) edge (behind Caddy only: a bare local API has no panel, no TLS, no HSTS)
const health = await fetch(`${api}/health`);
check(health.status === 200, `GET /api/v1/health → ${health.status}`);
if (local) {
  console.log("skip edge checks (local API without Caddy: login page, HSTS)");
} else {
  const login = await fetch(`${base}/login`);
  check(
    login.status === 200,
    `GET /login → ${login.status} (valid TLS: fetch verified the certificate)`,
  );
  check(!!login.headers.get("strict-transport-security"), "HSTS header present");
}
if (!local) {
  // (Caddy answers 404 for them; a bare local API answers with its own auth errors)
  for (const p of ["/api/v1/internal/rules", "/api/v1/webhooks/whatsapp"]) {
    check((await fetch(`${base}${p}`)).status === 404, `${p} → 404 (never public)`);
  }
}

// 2) login as the public operator
const info = await (await fetch(`${api}/demo/info`)).json();
check(info.operator?.email === "demo@smartops.test", `public operator is ${info.operator?.email}`);
check(
  JSON.stringify(info.samples) === JSON.stringify(SAMPLES.map(([kind]) => kind)),
  `the demo offers the six samples: ${info.samples?.join(", ")}`,
);
const res = await fetch(`${api}/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-smartops-csrf": "1", origin: base },
  body: JSON.stringify(info.operator),
});
check(res.status === 200, `public operator login → ${res.status}`);
if (res.status !== 200) process.exit(1);
const auth = { authorization: `Bearer ${(await res.json()).accessToken}` };

// 3) the content language of the deployment
const suppliers =
  (await (await fetch(`${api}/admin/suppliers`, { headers: auth })).json()).suppliers ?? [];
const names = suppliers.map((s) => s.name);
for (const expected of EXPECTED_SUPPLIERS[content]) {
  check(
    names.includes(expected),
    `demo content (${content}): supplier "${expected}" is in the catalog`,
  );
}

// 4) SSE through Caddy: the first frame must arrive at once, not at the end
for (const method of ["GET", "POST"]) {
  const t0 = performance.now();
  const s = await fetch(`${api}/events`, {
    method,
    headers: { ...auth, accept: "text/event-stream" },
  });
  const reader = s.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  const ms = Math.round(performance.now() - t0);
  check(
    s.status === 200 && first.includes("event: ready") && ms < 3000,
    `${method} /events: first frame in ${ms} ms`,
  );
  await reader.cancel();
}

// 5) the six samples, one after the other
console.log("\nsample          seconds  final state");
for (const [kind, expected] of SAMPLES) {
  const t0 = performance.now();
  const r = await fetch(`${api}/demo/inject`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ kind }),
  });
  if (r.status !== 202) {
    check(false, `${kind}: inject → ${r.status}`);
    continue;
  }
  const { wamid } = await r.json();
  let run = null;
  while (performance.now() - t0 < 120_000) {
    const trace = await (
      await fetch(`${api}/demo/trace/${wamid}`, { headers: auth })
    )
      .json()
      .catch(() => ({}));
    run = trace.run ?? null;
    if (run && FINAL.has(run.status)) break;
    await sleep(500);
  }
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`${kind.padEnd(15)} ${secs.padStart(7)}  ${run?.status ?? "NO RESULT"}`);
  check(run?.status === expected, `${kind} ends as ${expected} in ${secs} s`);
}
console.log(failures === 0 ? "\nDEMO CHECK PASSED" : `\nDEMO CHECK FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
