import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { createWebhookSweeper } from "../../src/modules/whatsapp/webhook-sweeper.js";
import { createFakeWebhookQueue, createInMemoryWebhookRepository } from "../helpers/build-app.js";

const log = pino({ level: "silent" });

describe("webhook sweeper", () => {
  it("re-enqueues stored events that were never enqueued, after the grace period", async () => {
    let clock = new Date("2026-09-24T12:00:00Z");
    const now = () => clock;
    const repository = createInMemoryWebhookRepository({ now });
    const queue = createFakeWebhookQueue();
    const sweeper = createWebhookSweeper({ repository, queue, graceMs: 60_000, now });

    await repository.saveEvent({ bodySha256: "a", payload: {} }); // enqueue failed at receive
    await repository.saveEvent({ bodySha256: "b", payload: {} });
    await repository.markEnqueued("evt-2"); // enqueued normally

    // Within the grace period: untouched.
    clock = new Date("2026-09-24T12:00:30Z");
    expect(await sweeper.run(log)).toBe(0);

    clock = new Date("2026-09-24T12:01:01Z");
    expect(await sweeper.run(log)).toBe(1);
    expect(queue.enqueued).toEqual(["evt-1"]);
    expect(repository.events[0]?.enqueuedAt).toEqual(clock);

    // Idempotent: nothing left to sweep.
    expect(await sweeper.run(log)).toBe(0);
  });

  it("keeps the event unenqueued if the queue is still down (next run retries)", async () => {
    const clock = new Date("2026-09-24T12:05:00Z");
    const repository = createInMemoryWebhookRepository({
      now: () => new Date("2026-09-24T12:00:00Z"),
    });
    await repository.saveEvent({ bodySha256: "a", payload: {} });
    const sweeper = createWebhookSweeper({
      repository,
      queue: createFakeWebhookQueue({ failWith: new Error("down") }),
      now: () => clock,
    });

    await expect(sweeper.run(log)).rejects.toThrow("down");
    expect(repository.events[0]?.enqueuedAt).toBeNull();
  });
});
