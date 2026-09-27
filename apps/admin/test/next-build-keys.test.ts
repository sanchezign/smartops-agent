import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Next.js writes random Draft/Preview Mode and Server Actions keys into every build, so they
 * ship inside the panel image. They are harmless ONLY while the panel uses neither feature
 * (phase 11 M4: scripts/ci/gitleaks-image.toml excepts exactly those keys). If this fails,
 * remove those exceptions and provide the keys at runtime instead.
 */
const SRC = new URL("../src/", import.meta.url);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("per-build Next.js keys stay unused", () => {
  it("no Server Actions and no Draft Mode anywhere in the panel sources", () => {
    const offenders = files(SRC.pathname.replace(/^\/([A-Za-z]:)/, "$1")).filter((file) =>
      /["']use server["']|\bdraftMode\s*\(|\bsetPreviewData\b/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
