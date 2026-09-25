import { convertDocx } from "./converters/docx.js";
import { convertSpreadsheet } from "./converters/spreadsheet.js";
import { convertCsv, convertPlainText } from "./converters/text.js";
import {
  DocumentRejectedError,
  documentFormat,
  type ConversionLimits,
  type ConversionResult,
} from "./document-types.js";

/**
 * Converts one document (runs INSIDE the isolated worker thread, see document-converter.ts).
 * Expected rejections (bomb, encrypted, empty…) come back as { ok: false, reason }.
 */
export async function convertDocument(
  input: { bytes: Uint8Array; mimeType: string; filename: string | null },
  limits: ConversionLimits,
): Promise<ConversionResult> {
  const format = documentFormat(input.mimeType, input.filename);
  if (!format) return { ok: false, reason: "unsupported_format", detail: input.mimeType };
  if (input.bytes.byteLength > limits.maxBytes) {
    return { ok: false, reason: "too_large", detail: `${input.bytes.byteLength} bytes` };
  }
  if (input.bytes.byteLength === 0) return { ok: false, reason: "empty" };
  try {
    switch (format) {
      case "xlsx":
      case "xls":
        return convertSpreadsheet(input.bytes, format, limits);
      case "csv":
        return convertCsv(input.bytes, limits);
      case "txt":
        return convertPlainText(input.bytes, limits);
      case "docx":
        return await convertDocx(input.bytes, limits);
    }
  } catch (err) {
    if (err instanceof DocumentRejectedError)
      return { ok: false, reason: err.reason, detail: err.message.slice(0, 300) };
    return {
      ok: false,
      reason: "invalid_document",
      detail: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    };
  }
}
