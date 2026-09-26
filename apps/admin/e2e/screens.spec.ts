import { test } from "@playwright/test";
import { login } from "./helpers";

/**
 * Visual review helper (not an assertion suite): full-page screenshots of every screen per
 * project into e2e/screens/ (gitignored). Run with SCREENS=1.
 */
const PAGES = [
  "/",
  "/revisiones",
  "/conversaciones",
  "/catalogo",
  "/alertas",
  "/reglas",
  "/usuarios",
];

test.skip(!process.env.SCREENS, "set SCREENS=1 to take screenshots");

test("screenshots", async ({ page }, info) => {
  await login(page);
  for (const path of PAGES) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const name = path === "/" ? "inicio" : path.slice(1).replaceAll("/", "-");
    await page.screenshot({ path: `e2e/screens/${info.project.name}-${name}.png`, fullPage: true });
  }
});
