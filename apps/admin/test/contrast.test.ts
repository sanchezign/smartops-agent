import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Phase 14 (ADR-029): the WCAG contrast of every token pair of globals.css, light and dark.
 * axe only measures what a page renders; it never checks control borders (1.4.11) and it cannot
 * see a pair nobody has rendered yet. Text pairs need 4.5:1; borders of controls and chart colors
 * (non-text) need 3:1.
 */
const CSS = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");

function block(selector: string): Record<string, string> {
  const start = CSS.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block`);
  const body = CSS.slice(CSS.indexOf("{", start) + 1, CSS.indexOf("\n}", start));
  const tokens: Record<string, string> = {};
  for (const m of body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) tokens[m[1]!] = m[2]!;
  return tokens;
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** [foreground token, background token] */
const TEXT: [string, string][] = [
  ["foreground", "background"],
  ["card-foreground", "card"],
  ["popover-foreground", "popover"],
  ["foreground", "surface"],
  ["muted-foreground", "background"],
  ["muted-foreground", "card"],
  ["muted-foreground", "muted"],
  ["muted-foreground", "surface"],
  ["primary-foreground", "primary"],
  ["secondary-foreground", "secondary"],
  ["accent-foreground", "accent"],
  ["destructive", "background"],
  ["destructive", "card"],
  ["warning", "background"],
  ["warning", "card"],
  ["signal-foreground", "signal"],
  ["sidebar-foreground", "sidebar"],
  ["sidebar-muted", "sidebar"],
  ["sidebar-muted", "sidebar-accent"],
  ["sidebar-accent-foreground", "sidebar-accent"],
  ["sidebar-primary-foreground", "sidebar-primary"],
];
/** Non-text: control borders, focus ring and chart colors (3:1). */
const NON_TEXT: [string, string][] = [
  ["input", "background"],
  ["input", "card"],
  ["ring", "background"],
  ["ring", "card"],
  ["chart-1", "card"],
  ["chart-2", "card"],
];
/**
 * The yellow never reaches 3:1 on a LIGHT page by itself: a yellow tile carries a frame in the
 * ink color (signal-foreground) there, and THAT frame must be visible. On the dark page the
 * yellow itself is the visible edge.
 */
const SIGNAL_EDGE = { light: "signal-foreground", dark: "signal" } as const;

/** "#rrggbb" of `fg` at `alpha` over `bg` (the translucent tints Tailwind draws, e.g. bg-destructive/10). */
function mix(fg: string, bg: string, alpha: number): string {
  const part = (i: number) => {
    const f = parseInt(fg.slice(1 + i * 2, 3 + i * 2), 16);
    const b = parseInt(bg.slice(1 + i * 2, 3 + i * 2), 16);
    return Math.round(f * alpha + b * (1 - alpha))
      .toString(16)
      .padStart(2, "0");
  };
  return `#${part(0)}${part(1)}${part(2)}`;
}

describe.each([
  ["light", ":root"],
  ["dark", ".dark"],
] as const)("token contrast, %s theme", (name, selector) => {
  const tokens = { ...block(":root"), ...(selector === ".dark" ? block(".dark") : {}) };
  const value = (token: string) => {
    const v = tokens[token];
    if (!v) throw new Error(`token --${token} is missing in ${selector}`);
    return v;
  };

  it.each(TEXT)("text: %s on %s ≥ 4.5:1", (fg, bg) => {
    expect(contrast(value(fg), value(bg))).toBeGreaterThanOrEqual(4.5);
  });
  it.each([
    ["background", 0.1],
    ["card", 0.1],
    ["card", 0.2],
  ] as const)("destructive text on its own tint over %s (%s) ≥ 4.5:1", (bg, alpha) => {
    const tint = mix(value("destructive"), value(bg), alpha);
    expect(contrast(value("destructive"), tint)).toBeGreaterThanOrEqual(4.5);
  });
  it.each(["background", "card"])("signal tile edge against %s ≥ 3:1", (bg) => {
    expect(contrast(value(SIGNAL_EDGE[name]), value(bg))).toBeGreaterThanOrEqual(3);
  });
  it.each(NON_TEXT)("non-text: %s against %s ≥ 3:1", (fg, bg) => {
    expect(contrast(value(fg), value(bg))).toBeGreaterThanOrEqual(3);
  });
});

describe("safety yellow (ADR-029)", () => {
  it("is the same hue in both themes and never the focus ring or a chart color", () => {
    const light = block(":root");
    const dark = block(".dark");
    expect(light.signal).toBe("#ffc400");
    expect(dark.signal).toBe("#ffc400");
    for (const t of [light, dark]) {
      for (const k of ["ring", "chart-1", "chart-2", "sidebar-accent", "primary"]) {
        expect(t[k], k).not.toBe("#ffc400");
      }
    }
  });
});
