import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkFile, headingSlugs, linkTargets, markdownFiles } from "../../scripts/ci/doc-links.js";

/** The documentation link checker (phase 13, quick CI job). */

describe("parsing", () => {
  it("finds link and image targets, ignoring code blocks and inline code", () => {
    const md = [
      "See [the guide](docs/guide.md) and ![shot](media/a.png).",
      '[titled](x.md "Title") and [external](https://example.com)',
      "`[not a link](nope.md)`",
      "```",
      "[also not](nope2.md)",
      "```",
    ].join("\n");
    expect(linkTargets(md)).toEqual([
      "docs/guide.md",
      "media/a.png",
      "x.md",
      "https://example.com",
    ]);
  });

  it("GitHub-style heading slugs, with repeats numbered", () => {
    const slugs = headingSlugs(
      "# Setup\n## Panel login (phase 8)\n## Costs: $0!\n## Setup\n### `code` and [link](x.md)",
    );
    expect([...slugs]).toEqual([
      "setup",
      "panel-login-phase-8",
      "costs-0",
      "setup-1",
      "code-and-link",
    ]);
  });
});

describe("checking files", () => {
  const dir = mkdtempSync(join(tmpdir(), "doc-links-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs", "guide.md"), "# Guide\n## Install steps\n");

  it("reports missing files and unknown anchors; external and valid links pass", () => {
    const file = join(dir, "README.md");
    writeFileSync(
      file,
      [
        "[ok](docs/guide.md)",
        "[ok anchor](docs/guide.md#install-steps)",
        "[folder](docs/)",
        "[web](https://example.com/missing)",
        "[gone](docs/missing.md)",
        "[bad anchor](docs/guide.md#nope)",
      ].join("\n"),
    );
    expect(checkFile(dir, file)).toEqual([
      { file: "README.md", target: "docs/missing.md", reason: "missing" },
      { file: "README.md", target: "docs/guide.md#nope", reason: "anchor" },
    ]);
  });

  it("the repository's own documentation has no broken links", () => {
    const root = resolve(import.meta.dirname, "../../../..");
    const problems = markdownFiles(root).flatMap((f) => checkFile(root, f));
    expect(problems).toEqual([]);
  });
});
