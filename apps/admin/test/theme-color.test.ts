import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { THEME_COLOR, themeColorFor } from "../src/lib/theme-color";

/** The browser UI colour follows the chosen theme (phase 16 M6a, Web Interface Guidelines). */

const CSS = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
const background = (selector: string) => {
  const start = CSS.indexOf(`${selector} {`);
  return /--background:\s*(#[0-9a-f]{6})/.exec(CSS.slice(start))?.[1];
};
const LIGHT_META = "(prefers-color-scheme: light)";
const DARK_META = "(prefers-color-scheme: dark)";

describe("theme-color", () => {
  it("is the page background of each theme", () => {
    expect(THEME_COLOR.light).toBe(background(":root"));
    expect(THEME_COLOR.dark).toBe(background(".dark"));
  });
  it("a theme chosen in the menu overrides both OS metas", () => {
    for (const media of [LIGHT_META, DARK_META]) {
      expect(themeColorFor("dark", "dark", media)).toBe(THEME_COLOR.dark);
      expect(themeColorFor("light", "light", media)).toBe(THEME_COLOR.light);
    }
  });
  it('"system" leaves each meta on its own OS scheme', () => {
    expect(themeColorFor("dark", "system", LIGHT_META)).toBe(THEME_COLOR.light);
    expect(themeColorFor("light", "system", DARK_META)).toBe(THEME_COLOR.dark);
    expect(themeColorFor("dark", "system", null)).toBe(THEME_COLOR.dark);
  });
});
