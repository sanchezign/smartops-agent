import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Media size budget of the repository (phase 13, user decision 2026-09-28): the README media
 * (English screenshots + the demo GIF) at most 8 MB, the Spanish guide's screenshots at most
 * 4 MB, and every committed media folder together at most 12 MB. Big files (the full video)
 * live outside the repository, in the portfolio kit.
 */

const ROOT = resolve(import.meta.dirname, "../../../..");
const MB = 1024 * 1024;
const README_MEDIA = join(ROOT, "docs/media");
const GUIDE_ES_MEDIA = join(ROOT, "docs/guide/media-es");
const MEDIA_EXT = /\.(png|jpe?g|gif|webp|avif|svg|mp4|webm|mov)$/i;
const SKIP = new Set(["node_modules", ".git", "dist", ".next", ".next-e2e", "e2e", "coverage"]);

const sizeOf = (dir: string): number =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).reduce(
        (sum, e) =>
          sum + (e.isDirectory() ? sizeOf(join(dir, e.name)) : statSync(join(dir, e.name)).size),
        0,
      )
    : 0;

/** Every media file under docs/ and the apps' public folders (what the repo ships as media). */
function mediaFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return SKIP.has(e.name) ? [] : mediaFiles(join(dir, e.name));
    return MEDIA_EXT.test(e.name) ? [join(dir, e.name)] : [];
  });
}

describe("media budget", () => {
  it("README media ≤ 8 MB", () => {
    expect(sizeOf(README_MEDIA) / MB).toBeLessThanOrEqual(8);
  });

  it("Spanish guide screenshots ≤ 4 MB", () => {
    expect(sizeOf(GUIDE_ES_MEDIA) / MB).toBeLessThanOrEqual(4);
  });

  it("all documentation and public media together ≤ 12 MB", () => {
    const files = [
      ...mediaFiles(join(ROOT, "docs")),
      ...mediaFiles(join(ROOT, "apps/admin/public")),
    ];
    const total = files.reduce((sum, f) => sum + statSync(f).size, 0);
    expect(total / MB).toBeLessThanOrEqual(12);
  });

  it("no video file is committed under docs (videos go to the portfolio kit)", () => {
    expect(mediaFiles(join(ROOT, "docs")).filter((f) => /\.(mp4|webm|mov)$/i.test(f))).toEqual([]);
  });
});
