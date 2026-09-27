import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * One version for the whole repository (phase 11 M5, user decision): release-please bumps the
 * root package.json and, through `extra-files`, both apps. This guard keeps them in lockstep
 * and catches a forgotten `release-as` (it would re-release the same version forever).
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

const semver = (v: string) => v.split(".").map(Number) as [number, number, number];
const greater = (a: string, b: string) => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
};

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

  it("a release-as pin is only allowed while it is ahead of the current version", () => {
    // After the forced first release (0.11.0) remove `release-as` from the config.
    const pin = config.packages["."]!["release-as"];
    if (pin !== undefined) expect(greater(pin, manifest["."]!)).toBe(true);
  });
});
