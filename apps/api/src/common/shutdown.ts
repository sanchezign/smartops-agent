import type { Logger } from "./logger.js";

/**
 * Graceful shutdown shared by the API and the worker (ADR-025). Each entry point registers a
 * "part" (what to stop, with its own time budget); a signal stops every registered part IN
 * PARALLEL and the process exits once, after all of them finished. Run alone, each entry behaves
 * as before; run together (`demo-server.ts`, the 1 GB demo) neither can kill the other half-way.
 */
export interface ShutdownPart {
  name: string;
  logger: Logger;
  /** Force the exit if this part has not finished by then. */
  timeoutMs: number;
  stop(): Promise<void>;
}

export interface ShutdownCoordinator {
  register(part: ShutdownPart): void;
  shutdown(reason: string, exitCode: number): void;
  readonly parts: readonly ShutdownPart[];
}

export function createShutdownCoordinator(deps: {
  exit: (code: number) => void;
  setTimer?: (fn: () => void, ms: number) => { unref(): void };
}): ShutdownCoordinator {
  const parts: ShutdownPart[] = [];
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  let shuttingDown = false;

  return {
    parts,
    register(part) {
      parts.push(part);
    },
    shutdown(reason, exitCode) {
      if (shuttingDown) return;
      shuttingDown = true;
      const log = parts[0]?.logger;
      log?.info({ reason, parts: parts.map((p) => p.name) }, "shutting down");

      const budget = Math.max(0, ...parts.map((p) => p.timeoutMs));
      setTimer(() => {
        log?.error("graceful shutdown timed out, forcing exit");
        deps.exit(1);
      }, budget).unref();

      void Promise.allSettled(
        parts.map((p) =>
          p.stop().catch((err: unknown) => p.logger.error({ err, part: p.name }, "error stopping")),
        ),
      ).then(() => deps.exit(exitCode));
    },
  };
}

let processCoordinator: ShutdownCoordinator | undefined;

/**
 * The process-wide coordinator: the first registration installs the signal and error handlers.
 * `unhandledRejection` shuts down with exit code 1; `uncaughtException` exits at once.
 */
export function registerShutdownPart(part: ShutdownPart): ShutdownCoordinator {
  if (!processCoordinator) {
    const coordinator = createShutdownCoordinator({ exit: (code) => process.exit(code) });
    processCoordinator = coordinator;
    process.on("SIGTERM", () => coordinator.shutdown("SIGTERM", 0));
    process.on("SIGINT", () => coordinator.shutdown("SIGINT", 0));
    process.on("unhandledRejection", (reason) => {
      part.logger.fatal({ err: reason }, "unhandled promise rejection");
      coordinator.shutdown("unhandledRejection", 1);
    });
    process.on("uncaughtException", (err) => {
      part.logger.fatal({ err }, "uncaught exception");
      process.exit(1);
    });
  }
  processCoordinator.register(part);
  return processCoordinator;
}
