import { describe, expect, it, vi } from "vitest";
import { createShutdownCoordinator } from "../../src/common/shutdown.js";

const logger = () => ({ info: vi.fn(), error: vi.fn(), fatal: vi.fn() }) as never;

function setup() {
  const exit = vi.fn();
  const timers: { fn: () => void; ms: number }[] = [];
  const coordinator = createShutdownCoordinator({
    exit,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return { unref() {} };
    },
  });
  return { exit, timers, coordinator };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("shutdown coordinator", () => {
  it("stops every part in parallel and exits once, after all of them", async () => {
    const { exit, coordinator } = setup();
    const order: string[] = [];
    let releaseApi!: () => void;
    coordinator.register({
      name: "api",
      logger: logger(),
      timeoutMs: 10_000,
      stop: () =>
        new Promise<void>((resolve) => {
          releaseApi = () => {
            order.push("api");
            resolve();
          };
        }),
    });
    coordinator.register({
      name: "worker",
      logger: logger(),
      timeoutMs: 30_000,
      stop: async () => {
        order.push("worker");
      },
    });
    coordinator.shutdown("SIGTERM", 0);
    await flush();
    expect(order).toEqual(["worker"]); // the worker did not wait for the API
    expect(exit).not.toHaveBeenCalled(); // and the process waits for both
    releaseApi();
    await flush();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("a second signal does nothing", async () => {
    const { exit, coordinator } = setup();
    const stop = vi.fn(async () => {});
    coordinator.register({ name: "api", logger: logger(), timeoutMs: 1, stop });
    coordinator.shutdown("SIGTERM", 0);
    coordinator.shutdown("SIGINT", 0);
    await flush();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("a part that fails to stop is logged and does not block the exit; the code is kept", async () => {
    const { exit, coordinator } = setup();
    const log = logger();
    coordinator.register({
      name: "api",
      logger: log,
      timeoutMs: 1,
      stop: async () => {
        throw new Error("boom");
      },
    });
    coordinator.shutdown("unhandledRejection", 1);
    await flush();
    expect(exit).toHaveBeenCalledWith(1);
    expect((log as unknown as { error: ReturnType<typeof vi.fn> }).error).toHaveBeenCalled();
  });

  it("forces the exit after the longest budget of the registered parts", () => {
    const { exit, timers, coordinator } = setup();
    const never = () => new Promise<void>(() => {});
    coordinator.register({ name: "a", logger: logger(), timeoutMs: 10_000, stop: never });
    coordinator.register({ name: "b", logger: logger(), timeoutMs: 30_000, stop: never });
    coordinator.shutdown("SIGTERM", 0);
    expect(timers.map((t) => t.ms)).toEqual([30_000]);
    timers[0]!.fn();
    expect(exit).toHaveBeenCalledWith(1);
  });
});
