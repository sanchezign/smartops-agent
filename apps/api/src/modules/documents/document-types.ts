/**
 * Document conversion contracts (phase 5 M3a, ADR-013). Spreadsheets, CSV, plain text and
 * Word documents are converted to text (Markdown tables) before extraction: Claude reads
 * PDF and images natively, but not xlsx / xls / csv / docx.
 */

export const DOCUMENT_FORMATS = ["xlsx", "xls", "csv", "txt", "docx"] as const;
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

export interface ConversionLimits {
  /** Max document size (bytes). */
  maxBytes: number;
  /** ZIP containers (xlsx, docx): max real uncompressed bytes, entries and ratio. */
  zipMaxUncompressedBytes: number;
  zipMaxEntries: number;
  zipMaxRatio: number;
  maxSheets: number;
  maxRowsPerSheet: number;
  maxColumns: number;
  /** Max characters of the resulting text (controls LLM input cost). */
  maxChars: number;
  /** Isolation: the conversion runs in a worker thread with these limits. */
  timeoutMs: number;
  heapMb: number;
}

export const DEFAULT_CONVERSION_LIMITS: ConversionLimits = {
  maxBytes: 10 * 1024 * 1024,
  zipMaxUncompressedBytes: 100 * 1024 * 1024,
  zipMaxEntries: 2_000,
  zipMaxRatio: 100,
  maxSheets: 10,
  maxRowsPerSheet: 2_000,
  maxColumns: 50,
  maxChars: 40_000,
  timeoutMs: 20_000,
  heapMb: 256,
};

export type ConversionWarningCode =
  | "hidden_sheets_skipped"
  | "hidden_rows_skipped"
  | "hidden_columns_skipped"
  | "formula_without_value"
  | "error_cells"
  | "rows_truncated"
  | "sheets_truncated"
  | "columns_truncated"
  | "chars_truncated"
  | "encoding_windows_1252"
  | "empty_sheets_skipped";

export interface ConversionWarning {
  code: ConversionWarningCode;
  message: string;
}

export interface SheetSummary {
  name: string;
  /** Data rows (excluding the header row). */
  dataRows: number;
  columns: number;
}

export type ConversionFailureReason =
  | "too_large"
  | "zip_bomb"
  | "too_many_entries"
  | "encrypted"
  | "unsupported_format"
  | "invalid_document"
  | "empty"
  | "timeout"
  | "out_of_memory";

export type ConversionResult =
  | {
      ok: true;
      format: DocumentFormat;
      text: string;
      charCount: number;
      /** Lines that can be a product: table data rows, or text lines with a digit. */
      dataRows: number;
      /** Some content was cut by a limit: never treat the document as a full list. */
      truncated: boolean;
      /** Values may be missing (formula without cached value): the run goes to review. */
      needsReview: boolean;
      sheets: SheetSummary[];
      warnings: ConversionWarning[];
    }
  | { ok: false; reason: ConversionFailureReason; detail?: string };

export class DocumentRejectedError extends Error {
  constructor(
    public readonly reason: ConversionFailureReason,
    detail: string,
  ) {
    super(detail);
    this.name = "DocumentRejectedError";
  }
}

const MIME_FORMATS: Record<string, DocumentFormat> = {
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel": "xls",
  "text/csv": "csv",
  "text/plain": "txt",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

/** Format to convert, or null (PDF, images and anything else are not converted). */
export function documentFormat(mimeType: string, filename: string | null): DocumentFormat | null {
  const mime = mimeType.split(";")[0]!.trim().toLowerCase();
  const format = MIME_FORMATS[mime] ?? null;
  // Many phones send CSV files as text/plain.
  if (format === "txt" && filename && /\.csv$/i.test(filename.trim())) return "csv";
  return format;
}
