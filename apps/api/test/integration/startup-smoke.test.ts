import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { PgBoss } from "pg-boss";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../src/common/db.js";
import { startBoss } from "../../src/jobs/boss.js";
import { QUEUE_DEFINITIONS, QUEUES } from "../../src/jobs/queues.js";
import { TEST_ENV_SOURCE } from "../helpers/build-app.js";
import { createTestPrisma, testDatabaseUrl } from "./db.js";

/**
 * Real startup / shutdown of the two processes (phase 10 M3, user addendum A): `server.ts` and
 * `worker.ts` start against the test database, the API answers /health, and SIGTERM ends each
 * one cleanly — the worker lets its in-flight job finish (pg-boss graceful stop), the API
 * closes its LISTEN connection and its pools. Exit code 0, no connection left behind.
 *
 * Env comes ONLY from this file (never from apps/api/.env): fake WhatsApp credentials and an
 * unreachable Graph URL, so nothing can reach Meta even if a leftover job runs. On Windows the
 * signal is delivered through support/signal-bridge.mjs (no POSIX signals there).
 */

const API_ROOT = fileURLToPath(new URL("../../", import.meta.url));
// --import takes a URL (a bare "C:\…" path is read as the scheme "c:").
const BRIDGE = new URL("./support/signal-bridge.mjs", import.meta.url).href;
const WINDOWS = process.platform === "win32";
const SYSTEM_VARS = ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE", "ComSpec"];

interface Proc {
  child: ChildProcess;
  logs: { msg: string; level: number; reason?: string }[];
  exited: Promise<number | null>;
}

function launch(entry: string, extraEnv: Record<string, string>): Proc {
  const env: Record<string, string> = {};
  for (const k of SYSTEM_VARS) if (process.env[k]) env[k] = process.env[k]!;
  Object.assign(env, TEST_ENV_SOURCE, {
    DATABASE_URL: testDatabaseUrl!,
    LOG_LEVEL: "info",
    WHATSAPP_GRAPH_BASE_URL: "http://127.0.0.1:9", // discard port: nothing ever reaches Meta
    ...extraEnv,
  });
  const child = spawn(
    process.execPath,
    ["--import", "tsx", ...(WINDOWS ? ["--import", BRIDGE] : []), entry],
    {
      cwd: API_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe", ...(WINDOWS ? (["ipc"] as const) : [])],
    },
  );
  const logs: Proc["logs"] = [];
  let buffer = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      try {
        logs.push(JSON.parse(line) as Proc["logs"][number]);
      } catch {
        logs.push({ msg: line, level: 0 });
      }
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => logs.push({ msg: chunk.toString(), level: 60 }));
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );
  return { child, logs, exited };
}

function terminate(proc: Proc): void {
  if (WINDOWS) proc.child.send("SIGTERM");
  else proc.child.kill("SIGTERM");
}

async function waitForLog(proc: Proc, pattern: RegExp, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!proc.logs.some((l) => pattern.test(l.msg))) {
    if (Date.now() > deadline || proc.child.exitCode !== null) {
      throw new Error(
        `no log ${pattern} (exit ${proc.child.exitCode}); got:\n${proc.logs.map((l) => l.msg).join("\n")}`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

describe.skipIf(!testDatabaseUrl)("startup smoke (server.ts, worker.ts)", () => {
  let prisma: PrismaClient;
  let boss: PgBoss;
  const started: Proc[] = [];

  const connections = async (applicationName: string) =>
    Number(
      (
        await prisma.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n FROM pg_stat_activity
           WHERE datname = current_database() AND application_name = ${applicationName}`
      )[0]!.n,
    );

  beforeAll(async () => {
    prisma = createTestPrisma();
    boss = await startBoss({
      databaseUrl: testDatabaseUrl!,
      logger: pino({ level: "silent" }),
      role: "api",
    });
    // A leftover job from another file must not run inside the real worker.
    for (const q of QUEUE_DEFINITIONS) await boss.deleteAllJobs(q.name);
    await prisma.$executeRawUnsafe("TRUNCATE TABLE integration_events, webhook_events CASCADE");
  }, 60_000);

  afterAll(async () => {
    // Only the processes THIS file started (never anything else on the machine).
    for (const p of started) if (p.child.exitCode === null) p.child.kill();
    await boss?.stop({ graceful: false });
    await prisma?.$disconnect();
  });

  it("the API starts, answers /health, and SIGTERM closes LISTEN and exits 0", async () => {
    const port = await freePort();
    const api = launch("src/server.ts", { PORT: String(port) });
    started.push(api);
    await waitForLog(api, /api listening/);

    const health = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
    expect(health.status).toBe(200);
    await expect.poll(() => connections("smartops-api-events"), { timeout: 10_000 }).toBe(1);

    terminate(api);
    const code = await api.exited;
    expect(code, api.logs.map((l) => l.msg).join("\n")).toBe(0);
    expect(api.logs.some((l) => l.msg === "shutting down" && l.reason === "SIGTERM")).toBe(true);
    expect(api.logs.filter((l) => l.level >= 50)).toEqual([]);
    await expect.poll(() => connections("smartops-api-events"), { timeout: 10_000 }).toBe(0);
    await expect.poll(() => connections("smartops-api"), { timeout: 10_000 }).toBe(0);
  }, 90_000);

  it("the worker finishes its in-flight job on SIGTERM, then exits 0", async () => {
    // Fake n8n that answers slowly: SIGTERM arrives while the delivery is in flight.
    let requests = 0;
    let release!: () => void;
    const gotRequest = new Promise<void>((resolve) => {
      release = resolve;
    });
    const n8n: Server = createServer((req, res) => {
      requests += 1;
      req.resume();
      release();
      setTimeout(() => res.writeHead(200).end("ok"), 1_500);
    });
    await new Promise<void>((r) => n8n.listen(0, "127.0.0.1", r));
    const n8nPort = (n8n.address() as AddressInfo).port;

    try {
      const event = await prisma.integrationEvent.create({
        data: { type: "message.ready", payload: {}, dedupeKey: `smoke:${crypto.randomUUID()}` },
      });
      const worker = launch("src/worker.ts", {
        N8N_DELIVERY_ENABLED: "true",
        N8N_RECEIVER_WEBHOOK_URL: `http://127.0.0.1:${n8nPort}/webhook/smartops`,
        N8N_WEBHOOK_SECRET: "smoke-test-shared-secret-value-0123456789",
      });
      started.push(worker);
      await waitForLog(worker, /worker started/);
      await boss.send(QUEUES.n8nDelivery, { eventId: event.id });

      await gotRequest;
      terminate(worker);
      const code = await worker.exited;

      expect(code, worker.logs.map((l) => l.msg).join("\n")).toBe(0);
      expect(
        worker.logs.some((l) => l.msg === "worker shutting down" && l.reason === "SIGTERM"),
      ).toBe(true);
      expect(requests).toBe(1);
      // The in-flight delivery completed before the process left.
      expect(
        await prisma.integrationEvent.findUniqueOrThrow({ where: { id: event.id } }),
      ).toMatchObject({ status: "delivered" });
      expect(worker.logs.filter((l) => l.level >= 50)).toEqual([]);
      await expect.poll(() => connections("smartops-worker"), { timeout: 10_000 }).toBe(0);
    } finally {
      await new Promise((r) => n8n.close(r));
    }
  }, 90_000);
});
