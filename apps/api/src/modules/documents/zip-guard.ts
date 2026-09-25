import { Unzip, UnzipInflate } from "fflate";
import { DocumentRejectedError, type ConversionLimits } from "./document-types.js";

/**
 * ZIP bomb guard for xlsx/docx (pure). Measures what REALLY decompresses (declared sizes
 * in a ZIP can lie): the archive is fed to a streaming inflater in 1 KB slices — deflate
 * expands at most ~1032:1, so each step produces ≤ ~1 MB — and the scan aborts as soon as
 * the total, the entry count or an entry's compression ratio exceeds the limits.
 * Output bytes are counted and discarded; the parser only runs after this passes.
 */

const SLICE = 1024;
class Abort extends Error {}

export function assertSafeZip(
  bytes: Uint8Array,
  limits: Pick<ConversionLimits, "zipMaxUncompressedBytes" | "zipMaxEntries" | "zipMaxRatio">,
): { entries: number; uncompressedBytes: number } {
  let total = 0;
  let entries = 0;
  let failure: DocumentRejectedError | null = null;
  const stop = (reason: "zip_bomb" | "too_many_entries", detail: string): never => {
    failure = new DocumentRejectedError(reason, detail);
    throw new Abort();
  };

  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = (file) => {
    entries += 1;
    if (entries > limits.zipMaxEntries)
      stop("too_many_entries", `more than ${limits.zipMaxEntries} entries`);
    let entryBytes = 0;
    const compressed = Math.max(file.size ?? 0, 1);
    file.ondata = (err, chunk) => {
      if (err) throw err;
      entryBytes += chunk.length;
      total += chunk.length;
      if (total > limits.zipMaxUncompressedBytes)
        stop("zip_bomb", `uncompressed size exceeds ${limits.zipMaxUncompressedBytes} bytes`);
      // Small entries (< 1 MB) may compress very well legitimately (empty XML).
      if (entryBytes > 1024 * 1024 && entryBytes / compressed > limits.zipMaxRatio)
        stop("zip_bomb", `compression ratio above ${limits.zipMaxRatio}:1 in ${file.name}`);
    };
    file.start();
  };

  try {
    for (let i = 0; i < bytes.length; i += SLICE) {
      const end = Math.min(i + SLICE, bytes.length);
      unzip.push(bytes.subarray(i, end), end === bytes.length);
    }
  } catch (err) {
    if (failure) throw failure;
    if (err instanceof DocumentRejectedError) throw err;
    throw new DocumentRejectedError(
      "invalid_document",
      `invalid ZIP container: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (entries === 0) throw new DocumentRejectedError("invalid_document", "empty ZIP container");
  return { entries, uncompressedBytes: total };
}
