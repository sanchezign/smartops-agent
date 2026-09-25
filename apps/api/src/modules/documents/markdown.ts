/**
 * Text helpers for converted documents (pure): table cells and Markdown tables with a
 * stable format (golden outputs depend on it), and the character cap.
 */

const MAX_CELL_CHARS = 300;

/** One line, no pipes breaking the table, collapsed spaces, capped. */
export function cleanCell(value: string): string {
  const text = value
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS)}…` : text;
}

/**
 * Markdown table: first row = header. Fully empty rows and columns are dropped; rows are
 * padded to the same width. Returns null when nothing is left.
 */
export function markdownTable(
  rows: string[][],
): { text: string; rows: number; columns: number } | null {
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (nonEmpty.length === 0) return null;
  const width = Math.max(...nonEmpty.map((r) => r.length));
  const keep: number[] = [];
  for (let c = 0; c < width; c += 1) {
    if (nonEmpty.some((r) => (r[c] ?? "").trim() !== "")) keep.push(c);
  }
  const table = nonEmpty.map((r) => keep.map((c) => cleanCell(r[c] ?? "")));
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  const [header, ...body] = table;
  const text = [line(header!), line(keep.map(() => "---")), ...body.map(line)].join("\n");
  return { text, rows: body.length, columns: keep.length };
}

/** Cuts at the last complete line under the cap. */
export function capChars(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const cut = text.lastIndexOf("\n", maxChars);
  return {
    text: `${text.slice(0, cut > 0 ? cut : maxChars)}\n[… documento truncado por tamaño …]`,
    truncated: true,
  };
}

/** Lines that may be a product in free text: non-empty with at least one digit. */
export function countDigitLines(text: string): number {
  return text.split("\n").filter((l) => /\d/.test(l) && !/^\|\s*---/.test(l)).length;
}
