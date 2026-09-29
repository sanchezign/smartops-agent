import { describe, expect, it } from "vitest";
import { isPanelPath } from "../src/features/digests/paths";

/** The digest page only follows in-panel paths (phase 9 M7): never an open redirect. */
describe("isPanelPath", () => {
  it.each([
    ["/reviews", true],
    ["/conversations/01a0dc63-e4b1-716c-a982-fbceaa90e2ba", true],
    ["//evil.example", false],
    ["https://evil.example", false],
    [null, false],
  ])("%s → %s", (path, ok) => {
    expect(isPanelPath(path)).toBe(ok);
  });
  it("rejects backslash tricks", () => {
    expect(isPanelPath(String.fromCharCode(47, 92) + "evil.example")).toBe(false);
  });
});
