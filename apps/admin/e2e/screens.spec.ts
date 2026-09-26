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
  "/conversaciones/bajas",
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
    // (never "networkidle": the real-time stream stays open, ADR-020)
    await page.getByRole("heading", { level: 1 }).first().waitFor();
    await page.waitForTimeout(800);
    const name = path === "/" ? "inicio" : path.slice(1).replaceAll("/", "-");
    await page.screenshot({ path: `e2e/screens/${info.project.name}-${name}.png`, fullPage: true });
  }
  // Chats: Norte (photo + spreadsheet) and Luis (human mode).
  for (const [search, name] of [
    ["Norte", "chat-norte"],
    ["Luis", "chat-luis"],
  ] as const) {
    await page.goto("/conversaciones");
    await page.getByLabel("Buscar por nombre, proveedor o teléfono").fill(search);
    await page.getByRole("list", { name: "Conversaciones" }).getByRole("link").first().click();
    await page.getByRole("region", { name: "Mensajes" }).waitFor();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `e2e/screens/${info.project.name}-${name}.png` });
  }
  // Product with its price history.
  await page.goto("/catalogo");
  await page.getByLabel("Buscar producto").fill("tornillo 6mm");
  await page.getByRole("list", { name: "Productos" }).getByRole("link").first().click();
  await page.getByRole("heading", { name: "Historial de precios" }).waitFor();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `e2e/screens/${info.project.name}-producto.png`, fullPage: true });
  // Review detail screens (one per resolver).
  for (const [title, name] of REVIEWS) {
    await page.goto("/revisiones");
    await page.getByRole("list", { name: "Revisiones" }).getByText(title).first().click();
    // (never "networkidle": the real-time stream stays open, ADR-020)
    await page.getByRole("heading", { level: 1 }).first().waitFor();
    await page.waitForTimeout(800);
    await page.screenshot({
      path: `e2e/screens/${info.project.name}-revision-${name}.png`,
      fullPage: true,
    });
  }
});
