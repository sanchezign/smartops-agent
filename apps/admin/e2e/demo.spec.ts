import { expect, test, type Page } from "@playwright/test";
import { E2E } from "./env";
import { expectAccessible } from "./helpers";

/**
 * Public demo (DEMO_MODE, phase 9 M8). The E2E API runs in demo mode with the real worker and
 * a stand-in for n8n (apps/api/scripts/demo/e2e-n8n.ts), so every button goes through the
 * real pipeline: signed webhook → worker → demo Graph API → transcription / conversion →
 * classify → extract (recorded outputs) → catalog / reviews.
 */

async function loginWithDemoCard(page: Page) {
  await page.goto("/login");
  const card = page.getByText("Public demo.").locator("..").locator("..");
  await expect(card.getByText(E2E.operator.email)).toBeVisible();
  await expect(card.getByText(E2E.operator.password)).toBeVisible();
  await page.getByRole("button", { name: "Use these details" }).click();
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
}

test.describe("public demo (phase 9 M8)", () => {
  test("login shows the public operator credentials; the panel shows the demo banner", async ({
    page,
  }) => {
    await loginWithDemoCard(page);
    await expect(page.getByText("Demo mode")).toBeVisible();
    await page.getByRole("link", { name: "Try the system" }).first().click();
    await expect(page.getByRole("heading", { name: "Try the system", level: 1 })).toBeVisible();
    await expectAccessible(page);
  });
});

test.describe("every sample goes through the real pipeline (desktop: shared demo data)", () => {
  test.skip(({ isMobile }) => isMobile, "runs once, on desktop");
  test.setTimeout(240_000);

  const cases: [string, RegExp][] = [
    ["Send a photo of a price list", /Catalog up to date|lines? to review/],
    ["Send a supplier PDF", /Processed: there were no price changes|Catalog up to date/],
    ["Send a supplier voice note", /to review|is in Reviews|Catalog up to date/],
    ["Send a known spreadsheet", /Catalog up to date/],
    ["Send a new spreadsheet", /new format/],
    ["Send a prompt-injection message", /orders to the system/],
  ];

  test("photo, PDF, voice note, known and new spreadsheet, prompt injection", async ({ page }) => {
    await loginWithDemoCard(page);
    await page.goto("/probar");
    for (const [button, outcome] of cases) {
      await page.getByRole("button", { name: button }).click();
      const card = page
        .getByRole("region", { name: "Sample messages sent" })
        .getByRole("status")
        .first();
      await expect(card).toHaveText(outcome, { timeout: 60_000 });
    }
    // The new spreadsheet waits for a person in Revisiones (column picker).
    await page.getByRole("link", { name: "Reviews", exact: true }).click();
    await expect(
      page.getByRole("list", { name: "Reviews" }).getByText("Precios Mayorista del Este.xlsx"),
    ).toBeVisible();
  });

  test("Reset demo brings the sample data back and keeps the session", async ({ page }) => {
    await loginWithDemoCard(page);
    // Open screens before the reset: a chat (stable id) and a review (recreated → new id).
    await page.goto("/conversaciones");
    await page.getByLabel("Search by name, supplier or phone").fill("Luis");
    await page
      .getByRole("list", { name: "Conversations" })
      .getByRole("link", { name: /Luis Fernández/ })
      .click();
    await expect(page.getByRole("heading", { name: "Luis Fernández" })).toBeVisible();
    const chatUrl = page.url();
    await page.goto("/revisiones");
    await page.getByRole("list", { name: "Reviews" }).getByText("Across-the-board change").click();
    await expect(page.getByRole("heading", { name: "Across-the-board change" })).toBeVisible();
    const reviewUrl = page.url();
    await page.goto("/probar");
    await page.getByRole("button", { name: "Reset demo" }).click();
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await expect(page.getByText("Demo reset:")).toBeVisible({ timeout: 60_000 });
    await page.getByRole("link", { name: "Reviews", exact: true }).click();
    const list = page.getByRole("list", { name: "Reviews" });
    await expect(list.getByText("Lista Distribuidora Norte.xlsx")).toBeVisible();
    await expect(list.getByText("Precios Mayorista del Este.xlsx")).toHaveCount(0);

    // The chat link survives the reset; the old review says it no longer exists.
    await page.goto(chatUrl);
    await expect(page.getByRole("heading", { name: "Luis Fernández" })).toBeVisible();
    await page.goto(reviewUrl);
    await expect(
      page.getByText("This no longer exists (the demo may have been reset)"),
    ).toBeVisible();
    await page.getByRole("link", { name: "Back to Reviews" }).click();
    await expect(page.getByRole("heading", { name: "Reviews", level: 1 })).toBeVisible();
  });
});
