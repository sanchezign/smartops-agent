#!/usr/bin/env node
/**
 * Coverage ratchet (phase 10, user rule): every threshold is the measured value minus 2
 * points (rounded down) and can only go UP, never down.
 *
 *   node scripts/coverage-ratchet.mjs apps/api          # after `pnpm test:coverage` in that app
 *   node scripts/coverage-ratchet.mjs apps/api --init   # first time: write every threshold
 *
 * Reads <app>/coverage/coverage-summary.json and <app>/coverage-thresholds.json. Global keys
 * (lines, branches, functions, statements) and per-file globs listed in the thresholds file
 * are raised when the measurement allows it; nothing is ever lowered (a guard test also
 * compares the file with HEAD and origin/main).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const METRICS = ["lines", "branches", "functions", "statements"];
const MARGIN = 2;
const [appDir, flag] = process.argv.slice(2);
if (!appDir) {
  console.error("usage: node scripts/coverage-ratchet.mjs <app dir> [--init]");
  process.exit(1);
}
const summary = JSON.parse(readFileSync(join(appDir, "coverage", "coverage-summary.json"), "utf8"));
const file = join(appDir, "coverage-thresholds.json");
const current = JSON.parse(readFileSync(file, "utf8"));
const floor = (pct) => Math.max(0, Math.floor(pct - MARGIN));
const norm = (p) => p.split("\\").join("/");

let raised = 0;
function ratchet(target, measured, label) {
  for (const m of METRICS) {
    if (typeof measured[m]?.pct !== "number") continue;
    const next = floor(measured[m].pct);
    const before = target[m];
    if (
      flag === "--init"
        ? before === undefined || next > before
        : before !== undefined && next > before
    ) {
      target[m] = next;
      raised += 1;
      console.log(`${label} ${m}: ${before ?? "-"} → ${next}`);
    }
  }
}

ratchet(current.global, summary.total, "global");
for (const [path, target] of Object.entries(current.files ?? {})) {
  const entry = Object.entries(summary).find(([f]) => norm(f).endsWith(`/${path}`));
  if (!entry) {
    console.warn(`not measured: ${path}`);
    continue;
  }
  ratchet(target, entry[1], path);
}
writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
console.log(raised ? `${raised} threshold(s) raised` : "no threshold changed");
