import { Worker } from "node:worker_threads";
import type { ConversionLimits, ConversionResult } from "./document-types.js";

/**
 * Isolated document conversion (ADR-013): every conversion runs in its own worker thread
 * with a V8 heap limit and a wall-clock timeout (terminate). The ZIP guard runs inside it
 * too, BEFORE any parser (the heap limit does not cover Buffers, so the guard is required).
 * In dev/tests the worker is the .ts source loaded through tsx; in production the built .js.
 */

export interface DocumentInput {
  bytes: Uint8Array;
  mimeType: string;
  filename: string | null;
}

export interface DocumentConverter {
  convert(input: DocumentInput): Promise<ConversionResult>;
}

function defaultWorker(): { url: URL; execArgv: string[] } {
  const isTs = import.meta.url.endsWith(".ts");
  return {
    url: new URL(isTs ? "./convert.worker.ts" : "./convert.worker.js", import.meta.url),
    execArgv: isTs ? ["--import", "tsx"] : [],
  };
}

export function createIsolatedDocumentConverter(
  limits: ConversionLimits,
  options: { workerUrl?: URL; execArgv?: string[] } = {},
): DocumentConverter {
  const worker = options.workerUrl
    ? { url: options.workerUrl, execArgv: options.execArgv ?? [] }
    : defaultWorker();

  return {
    convert(input) {
      return new Promise<ConversionResult>((resolve) => {
        let settled = false;
        const finish = (result: ConversionResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          void thread.terminate();
          resolve(result);
        };
        const thread = new Worker(worker.url, {
          execArgv: worker.execArgv,
          workerData: { ...input, limits },
          resourceLimits: { maxOldGenerationSizeMb: limits.heapMb, maxYoungGenerationSizeMb: 32 },
          stdout: false,
          stderr: false,
        });
        const timer = setTimeout(
          () => finish({ ok: false, reason: "timeout", detail: `${limits.timeoutMs} ms` }),
          limits.timeoutMs,
        );
        thread.once("message", (result: ConversionResult) => finish(result));
        thread.once("error", (err: Error & { code?: string }) =>
          finish(
            err.code === "ERR_WORKER_OUT_OF_MEMORY"
              ? { ok: false, reason: "out_of_memory", detail: `heap limit ${limits.heapMb} MB` }
              : { ok: false, reason: "invalid_document", detail: err.message.slice(0, 300) },
          ),
        );
        thread.once("exit", (code) => {
          if (!settled)
            finish({ ok: false, reason: "invalid_document", detail: `worker exited (${code})` });
        });
      });
    },
  };
}
