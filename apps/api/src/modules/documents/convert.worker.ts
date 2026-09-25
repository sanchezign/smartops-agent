import { parentPort, workerData } from "node:worker_threads";
import { convertDocument } from "./convert.js";
import type { ConversionLimits } from "./document-types.js";

/**
 * Worker-thread entry: converts ONE document and posts the result. Runs with a heap
 * limit and is terminated on timeout by document-converter.ts, so a malicious file
 * (ReDoS, pathological XML, huge sheets) cannot hang or exhaust the worker process.
 */
interface ConvertJob {
  bytes: Uint8Array;
  mimeType: string;
  filename: string | null;
  limits: ConversionLimits;
}

const job = workerData as ConvertJob;
const result = await convertDocument(
  { bytes: job.bytes, mimeType: job.mimeType, filename: job.filename },
  job.limits,
);
parentPort?.postMessage(result);
