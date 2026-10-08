import type { PrismaClient } from "../../common/db.js";
import type { DemoContent } from "./content/index.js";
import type { Logger } from "../../common/logger.js";
import type { CatalogIngestService } from "../catalog/catalog-ingest.service.js";
import type { DemoMediaStore } from "./demo-graph.js";
import { seedDemo, type DemoUsers, type SeedResult } from "./demo-seed.js";

/**
 * "Reiniciar demo" + the automatic reset (phase 9 M8): re-seeds the *_demo database, keeping
 * users and sessions (visitors stay logged in; the demo users get their public password back).
 * One reset at a time per process; the seed itself refuses any database not ending in _demo.
 */
export function createDemoReset(deps: {
  prisma: PrismaClient;
  catalog: CatalogIngestService;
  users: DemoUsers;
  assetsDir: string;
  /** The demo content to seed (ADR-031). */
  content: DemoContent;
  store: DemoMediaStore;
  logger: Logger;
  intervalMinutes: number;
  /** E2E only: keep re-creating each browser project's own reviews. */
  e2eReviews?: boolean;
}) {
  let running: Promise<SeedResult> | null = null;
  let lastResetAt: Date | null = null;
  let timer: NodeJS.Timeout | null = null;
  const log = deps.logger.child({ component: "demo-reset" });

  let active = false;
  /** Next automatic reset = interval after the LAST reset (a manual one moves it too). */
  function schedule() {
    if (!active || deps.intervalMinutes === 0) return;
    if (timer) clearTimeout(timer);
    const base = lastResetAt ?? startedAt;
    const delay = Math.max(1_000, base.getTime() + deps.intervalMinutes * 60_000 - Date.now());
    timer = setTimeout(() => {
      void reset("scheduled").catch((err: unknown) => {
        log.error({ err }, "scheduled demo reset failed");
        schedule();
      });
    }, delay);
    timer.unref();
  }

  async function reset(reason: "manual" | "scheduled"): Promise<SeedResult> {
    running ??= (async () => {
      try {
        const result = await seedDemo({
          prisma: deps.prisma,
          catalog: deps.catalog,
          users: deps.users,
          logger: log,
          keepAuth: true,
          assetsDir: deps.assetsDir,
          content: deps.content,
          e2eReviews: deps.e2eReviews ?? false,
        });
        deps.store.clear();
        lastResetAt = new Date();
        log.info({ reason }, "demo data reset");
        schedule();
        return result;
      } finally {
        running = null;
      }
    })();
    return running;
  }

  return {
    reset,
    /** When the data was last reset (manual or automatic); null = not since this process started. */
    lastResetAt: (): Date | null => lastResetAt,
    /** When the next automatic reset happens (null = automatic reset off). */
    nextResetAt(): Date | null {
      if (deps.intervalMinutes === 0) return null;
      const base = lastResetAt ?? startedAt;
      return new Date(base.getTime() + deps.intervalMinutes * 60_000);
    },
    start() {
      active = true;
      schedule();
    },
    stop() {
      active = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
const startedAt = new Date();
export type DemoReset = ReturnType<typeof createDemoReset>;
