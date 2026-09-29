import { test } from "@playwright/test";
import { login } from "./helpers";

/**
 * Visual review helper (not an assertion suite): full-page screenshots of every screen per
 * project into e2e/screens/ (gitignored). Run with SCREENS=1.
 */
const PAGES = [
  "/",
  "/reviews",
  "/conversations",
  "/conversations/opted-out",
  "/catalog",
  "/alerts",
  "/rules",
  "/users",
  "/try",
];

const REVIEWS: [string, string][] = [
  ["Lista Distribuidora Norte.xlsx", "planilla"],
  ["Arena gruesa", "linea"],
  ["Across-the-board change", "aumento"],
  ["Suspicious message", "sospechoso"],
];

test.skip(!process.env.SCREENS, "set SCREENS=1 to take screenshots");

test("screenshots", async ({ page }, info) => {
  test.setTimeout(240_000);
  await page.goto("/login");
  await page.getByText("Public demo.").waitFor();
  await page.screenshot({ path: `e2e/screens/${info.project.name}-login.png`, fullPage: true });
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
    await page.goto("/conversations");
    await page.getByLabel("Search by name, supplier or phone").fill(search);
    await page.getByRole("list", { name: "Conversations" }).getByRole("link").first().click();
    await page.getByRole("region", { name: "Messages" }).waitFor();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `e2e/screens/${info.project.name}-${name}.png` });
  }
  // Product with its price history.
  await page.goto("/catalog");
  await page.getByLabel("Search product").fill("tornillo 6mm");
  await page.getByRole("list", { name: "Products" }).getByRole("link").first().click();
  await page.getByRole("heading", { name: "Price history" }).waitFor();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `e2e/screens/${info.project.name}-producto.png`, fullPage: true });
  // Review detail screens (one per resolver).
  for (const [title, name] of REVIEWS) {
    await page.goto("/reviews");
    await page.getByRole("list", { name: "Reviews" }).getByText(title).first().click();
    // (never "networkidle": the real-time stream stays open, ADR-020)
    await page.getByRole("heading", { level: 1 }).first().waitFor();
    await page.waitForTimeout(800);
    await page.screenshot({
      path: `e2e/screens/${info.project.name}-revision-${name}.png`,
      fullPage: true,
    });
  }
});
