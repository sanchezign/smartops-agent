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

const REVIEWS: [string, string][] = [
  ["Lista Distribuidora Norte.xlsx", "planilla"],
  ["Arena gruesa", "linea"],
  ["Aumento general", "aumento"],
  ["Mensaje sospechoso", "sospechoso"],
];

test.skip(!process.env.SCREENS, "set SCREENS=1 to take screenshots");

test("screenshots", async ({ page }, info) => {
  test.setTimeout(240_000);
  await login(page);
  for (const path of PAGES) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const name = path === "/" ? "inicio" : path.slice(1).replaceAll("/", "-");
    await page.screenshot({ path: `e2e/screens/${info.project.name}-${name}.png`, fullPage: true });
  }
  // Review detail screens (one per resolver).
  for (const [title, name] of REVIEWS) {
    await page.goto("/revisiones");
    await page.getByRole("list", { name: "Revisiones" }).getByText(title).first().click();
    await page.waitForLoadState("networkidle");
    await page.screenshot({
      path: `e2e/screens/${info.project.name}-revision-${name}.png`,
      fullPage: true,
    });
  }
});
