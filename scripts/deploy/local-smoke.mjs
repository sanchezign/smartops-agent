// Local deploy harness, step "smoke" (phase 12): drives the stack deployed on https://localhost
// by scripts/deploy/local-harness.sh, THROUGH Caddy, like a visitor:
//   - security headers on the panel, internal routes blocked (404)
//   - SSE (GET and POST): first frame in ms, then a live event after a demo sample
//   - that sample through the real pipeline (webhook → worker → n8n → extract → ingest)
// Local only: Caddy's internal CA for localhost is not trusted by Node → TLS check off here.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
process.removeAllListeners("warning");

const origin = "https://localhost";
const base = `${origin}/api/v1`;
const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
};

// ── Edge ────────────────────────────────────────────────────────────────────────────────────
const page = await fetch(`${origin}/login`);
const h = (name) => page.headers.get(name) ?? "";
check(page.status === 200, `GET /login → ${page.status}`);
check(
  /max-age=\d{7,}/.test(h("strict-transport-security")),
  `HSTS: ${h("strict-transport-security")}`,
);
check(h("x-content-type-options") === "nosniff", "X-Content-Type-Options: nosniff");
check(h("x-frame-options") === "DENY", "X-Frame-Options: DENY");
check(
  h("content-security-policy").includes("frame-ancestors 'none'"),
  "CSP with frame-ancestors 'none'",
);
check(!!h("referrer-policy"), `Referrer-Policy: ${h("referrer-policy")}`);
check(!page.headers.has("server") && !page.headers.has("x-powered-by"), "no Server / X-Powered-By");
for (const path of ["/api/v1/internal/rules", "/api/v1/internal", "/api/v1/webhooks/whatsapp"]) {
  const status = (await fetch(`${origin}${path}`)).status;
  check(status === 404, `${path} → ${status} (never public)`);
}

// An oversized JSON body is refused at the edge (Caddy request_body max_size = the API's JSON limit).
const json = { "content-type": "application/json", "x-smartops-csrf": "1", origin };
const huge = await fetch(`${base}/auth/login`, {
  method: "POST",
  headers: json,
  body: JSON.stringify({ x: "a".repeat(2 * 1024 * 1024) }),
});
check(huge.status === 413, `2 MiB JSON body → ${huge.status} (refused at the edge)`);
const small = await fetch(`${base}/auth/login`, {
  method: "POST",
  headers: json,
  body: JSON.stringify({ x: "a" }),
});
check(small.status !== 413, `a small body is not refused as too large → ${small.status}`);

// ── Login as the public operator ─────────────────────────────────────────────────────────────
const info = await (await fetch(`${base}/demo/info`)).json();
const login = await fetch(`${base}/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-smartops-csrf": "1", origin },
  body: JSON.stringify(info.operator),
});
check(login.status === 200, `public operator login → ${login.status}`);
const { accessToken } = await login.json();
const auth = { authorization: `Bearer ${accessToken}` };
const logoutAll = await fetch(`${base}/auth/logout-all`, { method: "POST", headers: auth });
check(logoutAll.status === 403, `logout-all refused for the shared account → ${logoutAll.status}`);

// ── SSE through Caddy ────────────────────────────────────────────────────────────────────────
for (const method of ["GET", "POST"]) {
  const started = performance.now();
  const res = await fetch(`${base}/events`, {
    method,
    headers: { ...auth, accept: "text/event-stream" },
  });
  const reader = res.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  const ms = Math.round(performance.now() - started);
  check(
    res.status === 200 && first.includes("event: ready") && ms < 1000,
    `${method} /events: first frame in ${ms} ms`,
  );
  await reader.cancel();
}
const stream = await fetch(`${base}/events`, {
  method: "POST",
  headers: { ...auth, accept: "text/event-stream" },
});
const reader = stream.body.getReader();
await reader.read(); // ready
const injectedAt = performance.now();
const inject = await fetch(`${base}/demo/inject`, {
  method: "POST",
  headers: { ...auth, "content-type": "application/json" },
  body: JSON.stringify({ kind: "foto" }),
});
check(inject.status === 202, `demo sample accepted → ${inject.status}`);
const { wamid } = await inject.json();
let buffer = "";
while (!buffer.includes("event: events"))
  buffer += new TextDecoder().decode((await reader.read()).value);
const liveMs = Math.round(performance.now() - injectedAt);
check(liveMs < 5000, `first live event through Caddy ${liveMs} ms after the sample`);
await reader.cancel();

// ── The sample through the real pipeline (n8n included) ─────────────────────────────────────
let run = null;
for (let i = 0; i < 90 && !["ingested", "needs_review"].includes(run?.status); i += 1) {
  await new Promise((r) => setTimeout(r, 1000));
  run = (await (await fetch(`${base}/demo/trace/${wamid}`, { headers: auth })).json()).run ?? null;
}
check(
  run?.status === "ingested",
  `sample processed by the pipeline: run ${run?.status} (${run?.classification})`,
);

console.log(
  failures.length === 0 ? "\nLOCAL SMOKE PASSED" : `\nLOCAL SMOKE FAILED (${failures.length})`,
);
process.exit(failures.length === 0 ? 0 : 1);
