/**
 * claude-md:baseline — raises the size floor used by test/unit/claude-md.test.ts after an
 * intentional growth of CLAUDE.md. It NEVER lowers it (shrinking the project memory must
 * be a conscious edit of test/fixtures/claude-md-baseline.json in a reviewed commit).
 *
 *   pnpm --filter @smartops/api claude-md:baseline
 */
import { readFileSync, writeFileSync } from "node:fs";

const claudeMd = new URL("../../../CLAUDE.md", import.meta.url);
const file = new URL("../test/fixtures/claude-md-baseline.json", import.meta.url);

const lines = readFileSync(claudeMd, "utf8").split(/\r?\n/).length;
const current = JSON.parse(readFileSync(file, "utf8")) as { lines: number; minPhases: number };
if (lines <= current.lines) {
  process.stdout.write(`baseline kept at ${current.lines} lines (CLAUDE.md has ${lines})\n`);
} else {
  writeFileSync(file, `${JSON.stringify({ ...current, lines }, null, 2)}\n`);
  process.stdout.write(`baseline raised ${current.lines} → ${lines} lines\n`);
}
