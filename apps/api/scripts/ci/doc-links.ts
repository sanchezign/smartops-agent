/**
 * Documentation link checker (phase 13), run by the quick CI job:
 *   node apps/api/scripts/ci/doc-links.ts
 * Offline and deterministic: every RELATIVE link in the repository's Markdown must point to an
 * existing file or folder, and a `#anchor` must match a heading of the target file (GitHub's
 * slug rules). External links (http, mailto) are not fetched. Links inside code blocks and
 * inline code are ignored. Runs with Node's type stripping (no build, no install).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  ".next",
  ".next-e2e",
  "results",
  "report",
  "screens",
  "generated",
  ".sim",
]);

/** Markdown without fenced code blocks. */
export function stripFences(markdown: string): string {
  return markdown.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "");
}

/** Markdown without fenced code blocks and inline code (their contents are not links). */
export function stripCode(markdown: string): string {
  return stripFences(markdown).replace(/`[^`\n]*`/g, "");
}

/** Link targets of `[text](target)` and `[text](target "title")`, images included. */
export function linkTargets(markdown: string): string[] {
  const targets: string[] = [];
  const text = stripCode(markdown);
  for (const match of text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    targets.push(match[1]!);
  }
  // HTML inside Markdown (<img src>, <picture><source srcset>): every URL of a srcset list.
  for (const match of text.matchAll(/\b(src|srcset|href)="([^"]+)"/g)) {
    const urls = match[1] === "srcset" ? match[2]!.split(",") : [match[2]!];
    for (const url of urls) targets.push(url.trim().split(/\s+/)[0]!);
  }
  return targets;
}

/** GitHub's heading anchor: lowercase, punctuation removed, spaces → "-", repeats get "-1", "-2". */
export function headingSlugs(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const slugs = new Set<string>();
  // Inline code keeps its text in the anchor (only the backticks go).
  for (const match of stripFences(markdown).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const text = match[1]!
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](link) → text
      .replace(/[*_~`]/g, "");
    const base = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .replace(/\s/g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    slugs.add(n === 0 ? base : `${base}-${n}`);
  }
  return slugs;
}

const isExternal = (target: string) => /^[a-z][a-z0-9+.-]*:/i.test(target);

export interface LinkProblem {
  file: string;
  target: string;
  reason: "missing" | "anchor";
}

export function checkFile(root: string, file: string): LinkProblem[] {
  const markdown = readFileSync(file, "utf8");
  const problems: LinkProblem[] = [];
  for (const target of linkTargets(markdown)) {
    if (isExternal(target)) continue;
    const [path = "", anchor] = target.split("#") as [string, string | undefined];
    const resolved = path ? resolve(dirname(file), decodeURI(path)) : file;
    const shown = relative(root, file).replaceAll("\\", "/");
    if (!existsSync(resolved)) {
      problems.push({ file: shown, target, reason: "missing" });
      continue;
    }
    if (anchor && statSync(resolved).isFile() && resolved.endsWith(".md")) {
      if (!headingSlugs(readFileSync(resolved, "utf8")).has(decodeURIComponent(anchor)))
        problems.push({ file: shown, target, reason: "anchor" });
    }
  }
  return problems;
}

export function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory())
      return SKIP_DIRS.has(entry.name) ? [] : markdownFiles(join(dir, entry.name));
    return entry.name.endsWith(".md") ? [join(dir, entry.name)] : [];
  });
}

const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename);
if (invoked) {
  const root = resolve(import.meta.dirname, "../../../..");
  const files = markdownFiles(root);
  const problems = files.flatMap((file) => checkFile(root, file));
  for (const p of problems) {
    process.stderr.write(
      `${p.file}: ${p.reason === "missing" ? "missing target" : "unknown anchor"} → ${p.target}\n`,
    );
  }
  if (problems.length > 0) process.exit(1);
  process.stdout.write(`OK: documentation links (${files.length} Markdown files)\n`);
}
