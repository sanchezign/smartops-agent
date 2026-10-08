import { createHash } from "node:crypto";
import type { PrismaClient } from "../../src/common/db.js";

/**
 * A deterministic FINGERPRINT of a seeded demo database (phase 14 M5a): one hash per table of
 * every row, with what is random by nature masked (uuids, timestamps, binary data, SHA-256 hex
 * strings, argon2 hashes). Two seeds of the same content give the same fingerprint, so a
 * refactor of the seed can PROVE it did not change what the demo shows: the recorded
 * fingerprint of the Spanish content (test/fixtures/demo-seed-es.snapshot.json) was taken from
 * the seed as it was BEFORE the content became data.
 */

export interface TableFingerprint {
  rows: number;
  sha256: string;
}
export type DemoFingerprint = Record<string, TableFingerprint>;

const MASKS: [RegExp, string][] = [
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>"],
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)?/g, "<ts>"],
  [/\\\\x[0-9a-f]+/g, "<bin>"],
  [/\b[0-9a-f]{64}\b/g, "<sha>"],
  [/\$argon2[^"\\]*/g, "<hash>"],
];

function normalize(row: unknown): string {
  let text = JSON.stringify(row);
  for (const [pattern, replacement] of MASKS) text = text.replace(pattern, replacement);
  return text;
}

export async function demoFingerprint(prisma: PrismaClient): Promise<DemoFingerprint> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
     ORDER BY tablename`;
  const out: DemoFingerprint = {};
  for (const { tablename } of tables) {
    const rows = await prisma.$queryRawUnsafe<{ j: unknown }[]>(
      `SELECT to_jsonb(t) AS j FROM "${tablename}" t`,
    );
    if (rows.length === 0) continue;
    const lines = rows.map((r) => normalize(r.j)).sort();
    out[tablename] = {
      rows: rows.length,
      sha256: createHash("sha256").update(lines.join("\n")).digest("hex"),
    };
  }
  return out;
}
