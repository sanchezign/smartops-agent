import { expect, test, type Page } from "@playwright/test";
import { expectAccessible, login, navLink } from "./helpers";

/** Catalog, price history and alerts (phase 9 M5) on the seeded demo. */

async function goTo(page: Page, name: "Catalog" | "Alerts", isMobile: boolean) {
  if (name === "Alerts" && isMobile) await page.getByRole("button", { name: "More" }).click();
  await navLink(page, name).click();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
}

test.describe("catalog (phase 9 M5)", () => {
  test("products per supplier with price, change and a price history chart", async ({
    page,
    isMobile,
  }) => {
    await login(page, "operator");
    await goTo(page, "Catalog", isMobile);
    await page.getByRole("combobox", { name: "Supplier" }).click();
    await page.getByRole("option", { name: /Corvane Fasteners Inc./ }).click();
    await page.getByLabel("Search product").fill("hex bolt");
    const list = page.getByRole("list", { name: "Products" });
    await expect(list.getByRole("link")).toHaveCount(1);
    // US dollars in the English content (the currency comes from the content, phase 14 M5).
    await expect(list.getByText(/\$[0-9,]+\.\d\d/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Rename" })).toHaveCount(0); // operator
    await expectAccessible(page);

    await list.getByRole("link").click();
    await expect(page.getByRole("heading", { name: "Hex bolt 1/4 in", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Price history" })).toBeVisible();
    const changes = page.getByRole("list", { name: "Price changes" });
    await expect(changes.getByRole("listitem").first()).toBeVisible();
    expect(await changes.getByRole("listitem").count()).toBeGreaterThan(2);
    await expect(page.locator(".recharts-line-curve")).toBeVisible();
    await expectAccessible(page);
  });

  test("alerts: open ones with links to the product", async ({ page, isMobile }) => {
    await login(page, "operator");
    await goTo(page, "Alerts", isMobile);
    const list = page.getByRole("list", { name: "Alerts" });
    await expect(list.getByText("Price change").first()).toBeVisible();
    await expect(list.getByRole("link", { name: "View product" }).first()).toBeVisible();
    await expectAccessible(page);
  });
});

test.describe("catalog changes (desktop only: shared demo data)", () => {
  test.skip(({ isMobile }) => isMobile, "mutations run once, on desktop");

  test("an admin renames a supplier", async ({ page }) => {
    await login(page);
    await goTo(page, "Catalog", false);
    await page.getByRole("combobox", { name: "Supplier" }).click();
    await page.getByRole("option", { name: /Tessaly Paint & Coatings/ }).click();
    await page.getByRole("button", { name: "Rename" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Tessaly Paint & Coatings Ltd.");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Supplier renamed.")).toBeVisible();
    await page.getByRole("combobox", { name: "Supplier" }).click();
    await expect(
      page.getByRole("option", { name: /Tessaly Paint & Coatings Ltd\./ }),
    ).toBeVisible();
  });

  test("acknowledge an alert", async ({ page }) => {
    await login(page, "operator");
    await goTo(page, "Alerts", false);
    const first = page.getByRole("list", { name: "Alerts" }).getByRole("listitem").first();
    const title = (await first.locator("p").first().textContent())!;
    await first.getByRole("button", { name: /Mark as seen/ }).click();
    await expect(
      page.getByRole("list", { name: "Alerts" }).getByText(title, { exact: true }),
    ).toHaveCount(0);
  });
});
