/**
 * claude-md:baseline — raises the size floors used by test/unit/claude-md.test.ts after an
 * intentional growth of CLAUDE.md or docs/history/phase-log.md. It NEVER lowers them (shrinking
 * the project memory must be a conscious edit of test/fixtures/claude-md-baseline.json in a
 * reviewed commit).
 *
 *   pnpm --filter @smartops/api claude-md:baseline
 */
import { readFileSync, writeFileSync } from "node:fs";

const claudeMd = new URL("../../../CLAUDE.md", import.meta.url);
const phaseLog = new URL("../../../docs/history/phase-log.md", import.meta.url);
const file = new URL("../test/fixtures/claude-md-baseline.json", import.meta.url);

const count = (url: URL) => readFileSync(url, "utf8").split(/\r?\n/).length;
const current = JSON.parse(readFileSync(file, "utf8")) as {
  lines: number;
  phaseLogLines: number;
  minPhases: number;
};
const next = {
  ...current,
  lines: Math.max(current.lines, count(claudeMd)),
  phaseLogLines: Math.max(current.phaseLogLines, count(phaseLog)),
};
if (next.lines === current.lines && next.phaseLogLines === current.phaseLogLines) {
  process.stdout.write(
    `baseline kept at ${current.lines} / ${current.phaseLogLines} lines (CLAUDE.md / phase-log)\n`,
  );
} else {
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  process.stdout.write(
    `baseline raised ${current.lines} → ${next.lines} / ${current.phaseLogLines} → ${next.phaseLogLines} lines\n`,
  );
}
