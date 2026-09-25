import { Parser } from "htmlparser2";
import mammoth from "mammoth";
import {
  DocumentRejectedError,
  type ConversionLimits,
  type ConversionResult,
  type ConversionWarning,
} from "../document-types.js";
import { capChars, countDigitLines, markdownTable } from "../markdown.js";
import { assertSafeZip } from "../zip-guard.js";

/**
 * docx → text with Markdown tables (mammoth ≥ 1.11 + htmlparser2, ADR-013).
 * - External file access is disabled explicitly (CVE-2025-11849 was an arbitrary file
 *   read through images with external links) and images are dropped entirely.
 * - Paragraphs, headings and list items become lines; tables become Markdown tables
 *   (price lists in Word are usually tables). Headers, footers and comments are not read.
 */

/** mammoth's HTML → text lines + Markdown tables (no external dependency on the DOM). */
export function htmlToText(html: string): { text: string; tableRows: number; tables: number } {
  const blocks: string[] = [];
  let paragraph = "";
  let tableDepth = 0;
  let table: string[][] | null = null;
  let row: string[] | null = null;
  let cell: string | null = null;
  let tableRows = 0;
  let tables = 0;

  const flushParagraph = () => {
    const text = paragraph.replace(/\s+/g, " ").trim();
    if (text) blocks.push(text);
    paragraph = "";
  };

  const parser = new Parser(
    {
      onopentag(name) {
        if (name === "table") {
          tableDepth += 1;
          if (tableDepth === 1) {
            flushParagraph();
            table = [];
          }
        } else if (tableDepth === 1 && name === "tr") row = [];
        else if (tableDepth === 1 && (name === "td" || name === "th")) cell = "";
        else if (name === "br") {
          if (cell !== null) cell += " ";
          else paragraph += " ";
        }
      },
      ontext(text) {
        if (cell !== null) cell += text;
        else if (tableDepth === 0) paragraph += text;
      },
      onclosetag(name) {
        if (name === "table") {
          tableDepth -= 1;
          if (tableDepth === 0 && table) {
            const rendered = markdownTable(table);
            if (rendered) {
              blocks.push(rendered.text);
              tableRows += rendered.rows;
              tables += 1;
            }
            table = null;
          }
        } else if (tableDepth === 1 && (name === "td" || name === "th") && cell !== null) {
          row?.push(cell.trim()); // markdownTable cleans/escapes each cell once
          cell = null;
        } else if (tableDepth === 1 && name === "tr" && row) {
          (table as string[][] | null)?.push(row);
          row = null;
        } else if (tableDepth === 0 && /^(p|h[1-6]|li)$/.test(name)) {
          flushParagraph();
        }
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  flushParagraph();
  return { text: blocks.join("\n\n"), tableRows, tables };
}

export async function convertDocx(
  bytes: Uint8Array,
  limits: ConversionLimits,
): Promise<ConversionResult> {
  assertSafeZip(bytes, limits);
  let html: string;
  try {
    const result = await mammoth.convertToHtml(
      { buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) },
      {
        externalFileAccess: false,
        ignoreEmptyParagraphs: true,
        convertImage: mammoth.images.imgElement(async () => ({ src: "" })),
      } as Parameters<typeof mammoth.convertToHtml>[1],
    );
    html = result.value;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/password|encrypt/i.test(message)) throw new DocumentRejectedError("encrypted", message);
    throw new DocumentRejectedError("invalid_document", message.slice(0, 200));
  }

  const converted = htmlToText(html);
  if (converted.text.trim() === "") throw new DocumentRejectedError("empty", "empty Word document");
  const warnings: ConversionWarning[] = [];
  const capped = capChars(converted.text, limits.maxChars);
  if (capped.truncated)
    warnings.push({
      code: "chars_truncated",
      message: `El texto supera ${limits.maxChars} caracteres: se truncó.`,
    });
  // Table data rows + free-text lines with digits (outside tables).
  const outsideTables = capped.text
    .split("\n")
    .filter((l) => !l.startsWith("|"))
    .join("\n");
  return {
    ok: true,
    format: "docx",
    text: capped.text,
    charCount: capped.text.length,
    dataRows: converted.tableRows + countDigitLines(outsideTables),
    truncated: capped.truncated,
    needsReview: false,
    sheets: [],
    warnings,
  };
}
