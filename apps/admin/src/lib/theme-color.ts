/**
 * The browser UI colour (`<meta name="theme-color">`) = the page background of each theme (globals.css
 * `--background`; test/contrast.test.ts checks they match). Pure — unit tested.
 */
export const THEME_COLOR = { light: "#fdfbf7", dark: "#1c1917" } as const;

/**
 * What every theme-color meta must say for the theme the person chose in the user menu. The layout
 * renders one meta per OS scheme (media queries); a forced theme overrides both, "system" restores them.
 */
export function themeColorFor(
  resolved: string | undefined,
  chosen: string | undefined,
  media: string | null,
): string {
  if (chosen === "light" || chosen === "dark") return THEME_COLOR[chosen];
  if (media?.includes("dark")) return THEME_COLOR.dark;
  if (media?.includes("light")) return THEME_COLOR.light;
  return resolved === "dark" ? THEME_COLOR.dark : THEME_COLOR.light;
}
