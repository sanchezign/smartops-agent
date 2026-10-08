/**
 * Builds test/fixtures/heuristics-es-corpus.json (phase 14 M5b): every piece of Spanish-looking text
 * the repository's tests and demo already use — string literals of test/**\/*.test.ts and of the
 * Spanish demo content, text fields of the WhatsApp fixtures, the voice transcripts and the text
 * fixtures. test/unit/heuristics-es-identical.test.ts feeds each one to the heuristics with the
 * language set to "es" and to the frozen copy of the old code (test/legacy-es): the results must be
 * identical.
 *
 *   node scripts/fixtures/build-heuristics-corpus.mjs
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const api = fileURLToPath(new URL("../..", import.meta.url));
const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === "node_modules" || name === "legacy-es" || name === "generated") continue;
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
};

const SKIP_TESTS = ["heuristics-es-identical.test.ts", "heuristics-en.test.ts"];
const found = new Set();
const add = (text) => {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length >= 2 && t.length <= 400 && /[a-záéíóúñ]/i.test(t)) found.add(t);
};

const LITERAL = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\$]|\\.|\$(?!\{))*)`/g;
const unescape = (s) =>
  s
    .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\(["'`\\])/g, "$1")
    .replace(/\\n/g, "\n");
const scanSource = (file) => {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(LITERAL)) add(unescape(m[1] ?? m[2] ?? m[3] ?? ""));
};

for (const file of walk(join(api, "test")).filter(
  (f) => f.endsWith(".test.ts") && !SKIP_TESTS.some((s) => f.endsWith(s)),
)) {
  scanSource(file);
}
scanSource(join(api, "src/modules/demo/content/es.ts"));

// text fields of JSON fixtures (WhatsApp payloads, expected outputs…)
const textKeys = new Set([
  "body",
  "text",
  "caption",
  "transcript",
  "name",
  "title",
  "note",
  "filename",
]);
const scanJson = (value) => {
  if (Array.isArray(value)) value.forEach(scanJson);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "string" && textKeys.has(k)) add(v);
      else scanJson(v);
    }
  }
};
const SKIP_JSON = ["corpus", "snapshot", "authz"];
for (const file of walk(join(api, "test/fixtures")).filter(
  (f) => f.endsWith(".json") && !SKIP_JSON.some((s) => f.includes(s)),
)) {
  try {
    scanJson(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    /* not a JSON we can read */
  }
}
for (const file of [...walk(join(api, "test/fixtures")), ...walk(join(api, "demo"))].filter((f) =>
  f.endsWith(".txt"),
)) {
  const text = readFileSync(file, "utf8");
  for (const line of text.split("\n")) add(line);
  add(text);
}

const corpus = [...found].sort();
const out = join(api, "test/fixtures/heuristics-es-corpus.json");
writeFileSync(out, `[\n${corpus.map((t) => JSON.stringify(t)).join(",\n")}\n]\n`);
process.stdout.write(`${corpus.length} texts → ${relative(api, out)}\n`);
