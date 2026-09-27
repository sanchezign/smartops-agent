import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * One version for the whole repository (phase 11 M5, user decision): release-please bumps the
 * root package.json and, through `extra-files`, both apps. This guard keeps them in lockstep
 * and forbids a `release-as` pin in the config: it would propose the same version forever. The
 * first release (0.11.0) is forced by a commit body `Release-As: 0.11.0` instead (one-shot).
 */

const ROOT = new URL("../../../../", import.meta.url);
const readJson = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, ROOT), "utf8")) as T;

interface Config {
  "include-component-in-tag"?: boolean;
  "bootstrap-sha"?: string;
  packages: Record<
    string,
    { "release-as"?: string; "extra-files"?: { type: string; path: string; jsonpath?: string }[] }
  >;
}

const config = readJson<Config>("release-please-config.json");
const manifest = readJson<Record<string, string>>(".release-please-manifest.json");
const version = (path: string) => readJson<{ version: string }>(path).version;

describe("release-please configuration", () => {
  it("is a single root package whose tags are plain vX.Y.Z", () => {
    expect(Object.keys(config.packages)).toEqual(["."]);
    expect(Object.keys(manifest)).toEqual(["."]);
    expect(config["include-component-in-tag"]).toBe(false);
    expect(config["bootstrap-sha"]).toMatch(/^[0-9a-f]{40}$/);
  });

  it("bumps both apps together with the root", () => {
    const files = config.packages["."]!["extra-files"] ?? [];
    expect(files).toEqual(
      expect.arrayContaining([
        { type: "json", path: "apps/api/package.json", jsonpath: "$.version" },
        { type: "json", path: "apps/admin/package.json", jsonpath: "$.version" },
      ]),
    );
  });

  it("root, API and panel share the manifest version", () => {
    const current = manifest["."]!;
    expect(version("package.json")).toBe(current);
    expect(version("apps/api/package.json")).toBe(current);
    expect(version("apps/admin/package.json")).toBe(current);
  });

  it("never pins release-as in the config (use a Release-As commit footer)", () => {
    expect(JSON.stringify(config)).not.toContain("release-as");
  });
});
