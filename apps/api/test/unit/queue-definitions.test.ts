import { describe, expect, it } from "vitest";
import { QUEUE_DEFINITIONS, QUEUES } from "../../src/jobs/queues.js";

/**
 * Queue options are data (phase 10 M3): the promises written next to each queue (24 h for
 * n8n, media ids alive 7 days, DLQ before its queue…) are checked here, so a tweak to a
 * number cannot silently break them.
 *
 * Backoff = pg-boss 12.34 (dist/plans.js, failJobs): the n-th retry (retry_count = k before
 * it) waits LEAST(retryDelayMax, retryDelay · (2^(k+1)/2 + 2^(k+1)/2 · random())) seconds,
 * i.e. between retryDelay·2^k and retryDelay·2^(k+1), capped.
 */

const byName = new Map(QUEUE_DEFINITIONS.map((q) => [q.name, q]));
const def = (name: string) => byName.get(name)!;
const isDlq = (name: string) => name.endsWith("-dlq");
/** Cron queues: a failed run is replaced by the next tick. */
const CRON = new Set<string>([
  QUEUES.webhookSweeper,
  QUEUES.conversationModeSweeper,
  QUEUES.n8nWatchdog,
]);
/** Retried without a DLQ on purpose: the mode sweeper re-does lost reactivations. */
const NO_DLQ = new Set<string>([QUEUES.conversationBotResume]);

/** [min, max] seconds of waiting across every retry of a queue. */
export function totalBackoffSeconds(q: {
  retryLimit?: number;
  retryDelay?: number;
  retryBackoff?: boolean;
  retryDelayMax?: number;
}): [number, number] {
  const limit = q.retryLimit ?? 0;
  const delay = Math.max(q.retryDelay ?? 0, 1);
  const cap = q.retryDelayMax ?? Number.POSITIVE_INFINITY;
  let min = 0;
  let max = 0;
  for (let k = 0; k < limit; k += 1) {
    if (!q.retryBackoff) {
      min += q.retryDelay ?? 0;
      max += q.retryDelay ?? 0;
      continue;
    }
    const p = 2 ** Math.min(16, k + 1);
    min += Math.min(cap, (delay * p) / 2);
    max += Math.min(cap, delay * p);
  }
  return [min, max];
}

describe("queue definitions", () => {
  it("every queue name in QUEUES is defined exactly once, with a valid pg-boss name", () => {
    const names = QUEUE_DEFINITIONS.map((q) => q.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual(Object.values(QUEUES).sort());
    for (const n of names) expect(n).toMatch(/^[A-Za-z0-9_.\-/]+$/);
  });

  it("a dead letter queue is created BEFORE the queue that references it", () => {
    QUEUE_DEFINITIONS.forEach((q, i) => {
      if (!q.deadLetter) return;
      const at = QUEUE_DEFINITIONS.findIndex((d) => d.name === q.deadLetter);
      expect(at, `${q.name} → ${q.deadLetter}`).toBeGreaterThanOrEqual(0);
      expect(at, `${q.deadLetter} must come before ${q.name}`).toBeLessThan(i);
    });
  });

  it("every retried work queue ends in its own DLQ (except the documented ones)", () => {
    for (const q of QUEUE_DEFINITIONS) {
      if (isDlq(q.name) || CRON.has(q.name) || NO_DLQ.has(q.name)) continue;
      expect(q.deadLetter, q.name).toBe(`${q.name}-dlq`);
      expect(q.retryLimit ?? 0, q.name).toBeGreaterThan(0);
      expect(q.expireInSeconds, q.name).toBeGreaterThan(0);
    }
    for (const n of [...CRON, ...NO_DLQ]) expect(def(n).deadLetter, n).toBeUndefined();
  });

  it("dead letters are kept 30 days; cron runs are never retried", () => {
    for (const q of QUEUE_DEFINITIONS.filter((d) => isDlq(d.name))) {
      expect(q.deleteAfterSeconds, q.name).toBe(30 * 24 * 3600);
      expect(q.deadLetter, `${q.name} must not chain`).toBeUndefined();
    }
    for (const n of CRON) expect(def(n).retryLimit, n).toBe(0);
  });

  it("n8n delivery survives about a day of outage before giving up (user rule)", () => {
    const [min, max] = totalBackoffSeconds(def(QUEUES.n8nDelivery));
    expect(min / 3600).toBeGreaterThanOrEqual(23);
    expect(max / 3600).toBeLessThanOrEqual(26);
    expect(def(QUEUES.n8nDelivery).retryDelayMax).toBe(3600);
  });

  it("media downloads give up well inside the 7 days a Meta media id lives", () => {
    // FINDING (phase 10 M3, reported, not changed): the queue comment reads "10 s → 30 min
    // over 6 retries", but 6 retries add up to 10.5–21 min IN TOTAL (20…640 s each); the
    // 30-min cap is never reached. A token renewal must happen within ~20 min, or the media
    // ends failed/retries_exhausted and needs wa:media:retry. Pinned as it is today.
    const [min, max] = totalBackoffSeconds(def(QUEUES.whatsappMedia));
    expect([min, max]).toEqual([630, 1260]);
    expect(max).toBeLessThan(7 * 24 * 3600);
  });

  it("outbound keeps strict order per conversation", () => {
    expect(def(QUEUES.whatsappOutbound).policy).toBe("key_strict_fifo");
  });

  it("backoff arithmetic matches pg-boss for a known case", () => {
    // webhook: 5 retries, 5 s doubling, cap 300 → min 5+10+20+40+80, max 10+20+40+80+160.
    expect(totalBackoffSeconds(def(QUEUES.whatsappWebhook))).toEqual([155, 310]);
    expect(totalBackoffSeconds({ retryLimit: 3, retryDelay: 30 })).toEqual([90, 90]);
  });
});
