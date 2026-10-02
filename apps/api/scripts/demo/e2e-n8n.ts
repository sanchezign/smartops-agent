/**
 * E2E stand-in for n8n + the worker (phase 9 M8, dev tooling — not built). Playwright starts
 * it next to the demo API so "Probar el sistema" can be tested end to end without n8n:
 *
 * 1. waits until the API answers /api/v1/health (the API web server seeds the database first);
 * 2. starts the REAL worker (src/worker.ts) with the same environment;
 * 3. plays the three n8n workflows with the shared orchestrator (src/modules/demo/
 *    demo-orchestrator.ts, ADR-025): receive the secret-checked "message.ready" webhook →
 *    classify → notify customer queries / orders, or extract → ingest → notify → acknowledge.
 *
 * Env: API_URL (default http://127.0.0.1:4100), N8N_FAKE_PORT (default 4110),
 * N8N_WEBHOOK_SECRET, INTERNAL_API_KEY (from apps/api/.env).
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  createInternalApiCaller,
  createOrchestrator,
} from "../../src/modules/demo/demo-orchestrator.js";

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

// The same orchestrator the 1 GB public demo runs in-process (ADR-025): E2E exercises its steps.
const orchestrator = createOrchestrator({
  call: createInternalApiCaller({ baseUrl: apiUrl, apiKey }),
  logger: {
    info: () => undefined,
    warn: (...a: unknown[]) => process.stderr.write(`fake n8n: ${JSON.stringify(a)}\n`),
    error: (...a: unknown[]) => process.stderr.write(`fake n8n: ${JSON.stringify(a)}\n`),
  },
});

await waitForApi();
const worker = spawn(process.execPath, ["--import", "tsx", "src/worker.ts"], {
  env: process.env,
  stdio: "inherit",
});
// Leave only after the worker finished its graceful shutdown (it shares our stdout: exiting
// first would leave it holding the pipe Playwright waits on). Bounded: 12 s, then we go anyway.
const stop = () => {
  if (worker.exitCode !== null || worker.signalCode !== null) process.exit(0);
  worker.once("exit", () => process.exit(0));
  worker.kill("SIGTERM");
  setTimeout(() => process.exit(0), 12_000).unref();
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
    void orchestrator.handle(JSON.parse(body) as { messageId: string }).catch((err: unknown) => {
      process.stderr.write(`fake n8n: ${String(err)}\n`);
    });
  });
}).listen(port, "127.0.0.1", () => process.stdout.write(`fake n8n on :${port}\n`));
