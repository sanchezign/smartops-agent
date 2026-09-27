/**
 * E2E stand-in for n8n + the worker (phase 9 M8, dev tooling — not built). Playwright starts
 * it next to the demo API so "Probar el sistema" can be tested end to end without n8n:
 *
 * 1. waits until the API answers /api/v1/health (the API web server seeds the database first);
 * 2. starts the REAL worker (src/worker.ts) with the same environment;
 * 3. plays the three n8n workflows over HTTP, like the contract test
 *    (test/integration/n8n-contract.test.ts): receive the secret-checked "message.ready"
 *    webhook → classify → notify customer queries / orders, or extract → ingest → notify →
 *    acknowledge.
 *
 * Env: API_URL (default http://127.0.0.1:4100), N8N_FAKE_PORT (default 4110),
 * N8N_WEBHOOK_SECRET, INTERNAL_API_KEY (from apps/api/.env).
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const apiUrl = process.env.API_URL ?? "http://127.0.0.1:4100";
const port = Number(process.env.N8N_FAKE_PORT ?? 4110);
const secret = process.env.N8N_WEBHOOK_SECRET ?? "";
const apiKey = process.env.INTERNAL_API_KEY ?? "";

async function waitForApi(): Promise<void> {
  for (let i = 0; i < 240; i += 1) {
    try {
      if ((await fetch(`${apiUrl}/api/v1/health`)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error("API did not start");
}

async function call(method: "GET" | "POST", path: string, body?: object) {
  const res = await fetch(`${apiUrl}/api/v1/internal${path}`, {
    method,
    headers: { "content-type": "application/json", "x-internal-api-key": apiKey },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

/** What receiver + processor + notifier do (same mapping as the exported workflows). */
async function orchestrate(event: { messageId: string }): Promise<void> {
  const classified = await call("POST", "/classify", { messageId: event.messageId });
  const cls = classified.classification as string | null;
  const notifyKind = { customer_query: "customer_query", internal_order: "order" }[cls ?? ""];
  if (notifyKind) {
    await call("POST", "/notifications", { kind: notifyKind, messageId: event.messageId });
    return;
  }
  if (!(cls === null || cls === "price_list_full" || cls === "price_update_partial")) return;
  const runId = classified.runId as string | undefined;
  if (!runId) return;
  const extracted = await call("POST", "/extract", { runId });
  if (extracted.status === "extracted") await call("POST", "/catalog/ingest", { runId });
  await call("POST", "/notifications", { kind: "run", runId });
  await call("POST", "/messages/ack", { runId });
}

await waitForApi();
const worker = spawn(process.execPath, ["--import", "tsx", "src/worker.ts"], {
  env: process.env,
  stdio: "inherit",
});
const stop = () => {
  worker.kill();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") return res.writeHead(200).end("ok");
  let body = "";
  req.on("data", (c: Buffer) => (body += c.toString("utf8")));
  req.on("end", () => {
    if (req.headers["x-smartops-secret"] !== secret) return res.writeHead(403).end();
    res.writeHead(200).end('{"message":"Workflow was started"}');
    void orchestrate(JSON.parse(body) as { messageId: string }).catch((err: unknown) => {
      process.stderr.write(`fake n8n: ${String(err)}\n`);
    });
  });
}).listen(port, "127.0.0.1", () => process.stdout.write(`fake n8n on :${port}\n`));
