// Bounded abuse and load checks of the PUBLIC demo, run from your PC (phase 12 M6):
//
//   node scripts/deploy/demo-abuse-check.mjs https://smartops-demo.duckdns.org
//   node scripts/deploy/demo-abuse-check.mjs https://… --inject-burst        (also the sample queue)
//   node scripts/deploy/demo-abuse-check.mjs https://… --skip-login-limit    (keep your own login free)
//
// Every step has a hard cap on the number of requests (about 450 in total, 600 with --inject-burst)
// and nothing is written except demo samples (the demo resets itself every hour). It proves that:
//   1. the private surface is closed (admin, internal and webhook routes, oversized bodies);
//   2. the API answers a burst of 100 health requests (concurrency 10) quickly;
//   3. the event-stream cap per IP holds (6th stream -> 429 TOO_MANY_STREAMS);
//   4. the shared public account cannot sign out everybody (403);
//   5. the global per-IP limit answers 429 with Retry-After;
//   6. the login limit holds even when the client spoofs X-Forwarded-For (a new header on every try);
//   7. (--inject-burst) the per-IP sample cap answers 429 and the queue drains.
// SIDE EFFECTS to expect: after step 5 your IP waits up to a minute (the script waits for you); after
// step 6 YOUR IP cannot log in to the demo for up to 15 minutes; after step 7 you cannot send samples
// for up to 10 minutes. Run it when you do not need the demo yourself.
//
// Plain http is accepted only for 127.0.0.1 / localhost (the script's own test).
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const base = (args.find((a) => !a.startsWith("--")) ?? "").replace(/\/+$/, "");
const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base);
if (!/^https:\/\//.test(base) && !local) {
  console.error(
    "usage: node demo-abuse-check.mjs https://<your-demo-host> [--inject-burst] [--skip-login-limit]",
  );
  process.exit(2);
}
const api = `${base}/api/v1`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FINAL = new Set(["ingested", "needs_review", "failed", "rejected"]);
const SSE_MAX = Number(process.env.SSE_MAX_STREAMS_PER_USER ?? 5);
let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failures += 1;
};
const step = (title) => console.log(`\n== ${title}`);

async function call(method, path, { headers = {}, body, raw } = {}) {
  const res = await fetch(`${api}${path}`, {
    method,
    // A raw body is JSON too: without the content type Express does not parse it, so the size
    // limit is never reached and the API answers a validation error instead of 413.
    headers: {
      ...(body !== undefined || raw !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    redirect: "manual",
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON: fine
  }
  return { status: res.status, headers: res.headers, json };
}
const csrf = { "x-smartops-csrf": "1", origin: base };
const code = (r) => r.json?.error?.code;

async function pool(concurrency, total, fn) {
  let next = 0;
  const out = [];
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < total) {
        const i = next++;
        out[i] = await fn(i);
      }
    }),
  );
  return out;
}

// 1) the private surface
step("1. the private surface is closed");
for (const [method, path, want] of [
  ["GET", "/admin/users", 401],
  ["GET", "/auth/me", 401],
  ["GET", "/events", 401],
  ["POST", "/demo/inject", 401],
  ["GET", "/internal/rules", 404],
  ["GET", "/webhooks/whatsapp", 404],
  ["POST", "/webhooks/whatsapp", 404],
]) {
  const r = await call(method, path, method === "POST" ? { body: {} } : {});
  // (Caddy hides internal and webhook routes with a 404; a bare local API answers with its own
  // auth/validation error, so locally "closed" means any 400/401/404)
  const ok = local && want === 404 ? [400, 401, 404].includes(r.status) : r.status === want;
  check(
    ok,
    `${method} /api/v1${path} -> ${r.status} (expected ${local && want === 404 ? "closed" : want})`,
  );
}
const big = await call("POST", "/auth/login", {
  headers: csrf,
  raw: JSON.stringify({ x: "a".repeat(2 * 1024 * 1024) }),
});
check(
  big.status === 413,
  `2 MB body to /auth/login -> ${big.status} ${code(big) ?? ""} (expected 413)`,
);

// 2) a small load smoke
step("2. a burst of 100 health requests, 10 at a time");
const times = [];
const codes = await pool(10, 100, async () => {
  const t0 = performance.now();
  const r = await call("GET", "/health");
  times.push(performance.now() - t0);
  return r.status;
});
times.sort((a, b) => a - b);
const p = (q) => Math.round(times[Math.min(times.length - 1, Math.floor(times.length * q))]);
check(
  codes.every((c) => c === 200),
  `all 100 answered 200 (got ${[...new Set(codes)].join(", ")})`,
);
check(
  p(0.95) < 3000,
  `latency p50 ${p(0.5)} ms, p95 ${p(0.95)} ms, max ${p(1)} ms (p95 must be under 3000 ms)`,
);

// 3) sign in as the public operator (the credentials the login screen shows)
step("3. the shared public account");
const info = await call("GET", "/demo/info");
if (info.status !== 200 || !info.json?.operator) {
  check(false, `GET /demo/info -> ${info.status}: not a demo server?`);
  process.exit(1);
}
const login = await call("POST", "/auth/login", { headers: csrf, body: info.json.operator });
check(login.status === 200, `public operator login -> ${login.status}`);
if (login.status !== 200) process.exit(1);
const auth = { authorization: `Bearer ${login.json.accessToken}` };

// 4) the stream cap per IP
const controllers = [];
const statuses = [];
for (let i = 0; i < SSE_MAX + 1; i += 1) {
  const ac = new AbortController();
  controllers.push(ac);
  const res = await fetch(`${api}/events`, {
    headers: { ...auth, accept: "text/event-stream" },
    signal: ac.signal,
  });
  statuses.push(res.status);
  if (res.status !== 200) {
    const body = await res.json().catch(() => null);
    check(
      body?.error?.code === "TOO_MANY_STREAMS",
      `stream ${i + 1} refused with TOO_MANY_STREAMS`,
    );
  }
}
check(
  statuses.slice(0, SSE_MAX).every((s) => s === 200) && statuses[SSE_MAX] === 429,
  `event streams: first ${SSE_MAX} open (200), the next one is refused (${statuses[SSE_MAX]})`,
);
for (const ac of controllers) ac.abort();
await sleep(500);

// 5) the shared account cannot sign everybody out
const all = await call("POST", "/auth/logout-all", { headers: { ...csrf, ...auth } });
check(all.status === 403, `logout-all with the shared account -> ${all.status} (expected 403)`);

// 6) the global per-IP limit
step("4. the global per-IP limit (up to 330 requests)");
let limited = null;
let sent = 0;
await pool(15, 330, async () => {
  if (limited) return;
  sent += 1;
  const r = await call("GET", "/demo/info");
  if (r.status === 429 && !limited) limited = r;
});
check(
  limited?.status === 429 && code(limited) === "RATE_LIMITED",
  `a 429 RATE_LIMITED arrived within ${sent} requests`,
);
const retryAfter = Number(limited?.headers.get("retry-after") ?? 0);
check(retryAfter > 0 && retryAfter <= 120, `it carries Retry-After (${retryAfter} s)`);
if (limited) {
  console.log(`     waiting ${retryAfter + 1} s for your IP to be free again…`);
  await sleep((retryAfter + 1) * 1000);
}

// 7) the login limit cannot be dodged by lying about the client address
if (flags.has("--skip-login-limit")) {
  console.log("\n== 5. login limit: skipped (--skip-login-limit)");
} else {
  step("5. the login limit with a spoofed X-Forwarded-For on every attempt (up to 14)");
  const email = `abuse-check-${Math.random().toString(36).slice(2, 10)}@example.invalid`;
  const seen = [];
  for (let i = 0; i < 14; i += 1) {
    const r = await call("POST", "/auth/login", {
      headers: { ...csrf, "x-forwarded-for": `203.0.113.${i + 1}` },
      body: { email, password: "definitely-not-the-password-123" },
    });
    seen.push(r.status);
    if (r.status === 429) break;
  }
  const first429 = seen.indexOf(429);
  check(
    first429 > 0 && first429 <= 11,
    `login answered 429 after ${first429} tries (${seen.join(" ")}): the spoofed header did not dodge it`,
  );
  check(
    seen.slice(0, Math.max(first429, 0)).every((s) => s === 401),
    "every earlier try was a plain 401 (no hint about the account)",
  );
}

// 8) the sample queue
if (flags.has("--inject-burst")) {
  step("6. a burst of samples (up to 25) against the per-IP cap and the one-at-a-time queue");
  let accepted = 0;
  let last = null;
  let refused = null;
  const t0 = performance.now();
  for (let i = 0; i < 25; i += 1) {
    const r = await call("POST", "/demo/inject", { headers: auth, body: { kind: "injection" } });
    if (r.status === 202) {
      accepted += 1;
      last = r.json?.wamid;
    } else {
      refused = r;
      break;
    }
  }
  check(
    refused?.status === 429,
    `the cap answered ${refused?.status ?? "nothing"} after ${accepted} accepted samples (expected 429)`,
  );
  if (last) {
    let run = null;
    while (performance.now() - t0 < 240_000) {
      const trace = await call("GET", `/demo/trace/${last}`, { headers: auth });
      run = trace.json?.run ?? null;
      if (run && FINAL.has(run.status)) break;
      await sleep(1000);
    }
    const secs = Math.round((performance.now() - t0) / 1000);
    check(
      !!run && FINAL.has(run.status),
      `the last accepted sample reached "${run?.status ?? "NO RESULT"}" ${secs} s after the burst started`,
    );
  }
  const health = await call("GET", "/health");
  check(health.status === 200, `the API still answers health after the burst (${health.status})`);
}

console.log(failures === 0 ? "\nABUSE CHECK PASSED" : `\nABUSE CHECK FAILED (${failures})`);
console.log(
  "Now look at the VM: `sudo /opt/smartops/current/bin/status.sh`, `free -m`, `sudo docker stats --no-stream`.",
);
process.exit(failures === 0 ? 0 : 1);
