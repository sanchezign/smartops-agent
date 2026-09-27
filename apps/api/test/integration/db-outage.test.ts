import { createServer, Socket, type Server } from "node:net";
import { Writable } from "node:stream";
import type { PgBoss } from "pg-boss";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, type PrismaClient } from "../../src/common/db.js";
import { startBoss } from "../../src/jobs/boss.js";
import type { PanelEvent } from "../../src/modules/events/panel-events.js";
import { createPgListener, type PgListener } from "../../src/modules/events/pg-listener.js";
import { createHealthRepository } from "../../src/modules/health/health.repository.js";
import { buildTestApp } from "../helpers/build-app.js";
import { createTestPrisma, resetWhatsAppTables, testDatabaseUrl } from "./db.js";

/**
 * Postgres goes away and comes back (phase 10 M5, user choice: a TCP proxy INSIDE the test —
 * the real container is never stopped). The API process's three kinds of connections go
 * through the proxy: Prisma's pool (health), the one LISTEN connection (real time) and
 * pg-boss's pool. Cutting the proxy kills every open socket and refuses new ones; restoring
 * it must bring all three back WITHOUT restarting anything:
 * - /api/v1/health 200 → 503 → 200;
 * - the listener reconnects, asks the hub to resync, and delivers new events;
 * - a pg-boss worker keeps polling through the errors and runs the job queued meanwhile.
 */

interface TcpProxy {
  port: number;
  cut(): Promise<void>;
  restore(): Promise<void>;
  close(): Promise<void>;
}

async function startTcpProxy(target: { host: string; port: number }): Promise<TcpProxy> {
  const pairs = new Set<Socket>();
  let server: Server;
  let port = 0;
  const listen = async () => {
    server = createServer((client) => {
      const upstream = new Socket();
      pairs.add(client).add(upstream);
      const drop = () => {
        client.destroy();
        upstream.destroy();
        pairs.delete(client);
        pairs.delete(upstream);
      };
      client.on("error", drop).on("close", drop);
      upstream.on("error", drop).on("close", drop);
      upstream.connect(target.port, target.host, () => {
        client.pipe(upstream).pipe(client);
      });
    });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  };
  const stop = async () => {
    for (const s of pairs) s.destroy();
    pairs.clear();
    await new Promise((resolve) => server.close(resolve));
  };
  await listen();
  return { port, cut: stop, restore: listen, close: stop };
}

describe.skipIf(!testDatabaseUrl)("Postgres outage and recovery (TCP proxy)", () => {
  let proxy: TcpProxy;
  let viaProxy: string;
  let direct: PrismaClient;
  let prisma: PrismaClient;
  let listener: PgListener;
  let bossViaProxy: PgBoss;
  let bossDirect: PgBoss;
  const events: PanelEvent[] = [];
  let resyncs = 0;
  const bossErrors: string[] = [];
  const handled: number[] = [];
  const QUEUE = "phase10-db-outage";

  const logger = pino(
    { level: "warn" },
    new Writable({
      write(chunk: Buffer, _e, done) {
        const line = JSON.parse(chunk.toString()) as { msg: string };
        if (line.msg === "pg-boss error") bossErrors.push(line.msg);
        done();
      },
    }),
  );

  beforeAll(async () => {
    const target = new URL(testDatabaseUrl!);
    proxy = await startTcpProxy({ host: target.hostname, port: Number(target.port || 5432) });
    const url = new URL(testDatabaseUrl!);
    url.hostname = "127.0.0.1";
    url.port = String(proxy.port);
    viaProxy = url.toString();

    direct = createTestPrisma();
    await resetWhatsAppTables(direct);
    prisma = createPrismaClient(viaProxy, pino({ level: "silent" }));
    listener = createPgListener({
      connectionString: viaProxy,
      onEvent: (e) => events.push(e),
      onReconnect: () => (resyncs += 1),
      logger: pino({ level: "silent" }),
      backoffMs: () => 200,
    });
    await listener.start();

    bossDirect = await startBoss({ databaseUrl: testDatabaseUrl!, logger, role: "api" });
    if (!(await bossDirect.getQueue(QUEUE))) await bossDirect.createQueue(QUEUE, { retryLimit: 0 });
    await bossDirect.deleteAllJobs(QUEUE);
    bossViaProxy = await startBoss({ databaseUrl: viaProxy, logger, role: "api" });
    await bossViaProxy.work<{ n: number }>(
      QUEUE,
      { pollingIntervalSeconds: 0.5 },
      async ([job]) => {
        if (job) handled.push(job.data.n);
      },
    );
  }, 60_000);

  afterAll(async () => {
    await bossViaProxy?.stop({ graceful: false });
    await listener?.stop();
    await prisma?.$disconnect();
    await proxy?.close();
    if (bossDirect) {
      await bossDirect.deleteQueue(QUEUE);
      await bossDirect.stop({ graceful: false });
    }
    await direct?.$disconnect();
  }, 60_000);

  it("health, LISTEN and pg-boss all recover once the database is back", async () => {
    const app = buildTestApp({ healthRepository: createHealthRepository(prisma) });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const health = async () =>
      (await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/health`))
        .status;
    const contact = await direct.contact.create({ data: { waId: "59800000999" } });
    const conversation = await direct.conversation.create({ data: { contactId: contact.id } });
    try {
      // Up: everything works through the proxy.
      expect(await health()).toBe(200);
      await bossDirect.send(QUEUE, { n: 1 });
      await expect.poll(() => handled, { timeout: 10_000 }).toEqual([1]);

      // Down.
      await proxy.cut();
      await expect.poll(health, { timeout: 15_000, interval: 250 }).toBe(503);
      await expect.poll(() => listener.connected(), { timeout: 5_000 }).toBe(false);
      await bossDirect.send(QUEUE, { n: 2 }); // queued while the worker cannot reach the DB
      await direct.conversation.update({ where: { id: conversation.id }, data: { mode: "human" } });
      await new Promise((r) => setTimeout(r, 1_500)); // a few failed polls
      expect(handled).toEqual([1]);
      expect(bossErrors.length, "pg-boss felt the outage (logged, not crashed)").toBeGreaterThan(0);

      // Back.
      await proxy.restore();
      await expect.poll(health, { timeout: 15_000, interval: 250 }).toBe(200);
      await expect.poll(() => listener.connected(), { timeout: 15_000 }).toBe(true);
      expect(resyncs).toBeGreaterThanOrEqual(1); // the event sent while down is lost → resync
      await expect.poll(() => handled, { timeout: 15_000 }).toEqual([1, 2]);

      // And new changes are announced again.
      await direct.conversation.update({ where: { id: conversation.id }, data: { mode: "bot" } });
      await expect
        .poll(() => events.some((e) => e.type === "conversation.updated" && e.mode === "bot"), {
          timeout: 10_000,
        })
        .toBe(true);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }, 90_000);
});
