import { expect, test } from "@playwright/test";
import { expectAccessible, login } from "./helpers";

test.describe("panel shell + dashboard (phase 9 M1)", () => {
  test("login lands on the dashboard with the seeded numbers", async ({ page }) => {
    await login(page);
    await expect(page.getByText("Pending reviews")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Messages per day" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "What was resolved without calling the AI" }),
    ).toBeVisible();
    await expect(page.getByText("Greetings and chit-chat")).toBeVisible();
    await expectAccessible(page);
  });

  test("the period switch reloads the data", async ({ page }) => {
    await login(page);
    await page.getByRole("button", { name: "30 days" }).click();
    await expect(page.getByText("Last 30 days")).toBeVisible();
  });

  test("navigation: bottom bar on phones, sidebar on desktop", async ({ page, isMobile }) => {
    await login(page);
    if (isMobile) {
      await page.getByRole("button", { name: "More" }).click();
      await expect(page.getByRole("link", { name: "Rules" })).toBeVisible();
      await page.getByRole("link", { name: "Rules" }).click();
    } else {
      await page.getByRole("link", { name: "Rules" }).first().click();
    }
    await expect(page.getByRole("heading", { name: "Rules" })).toBeVisible();
  });

  test("an operator does not see the Users section", async ({ page, isMobile }) => {
    await login(page, "operator");
    if (isMobile) await page.getByRole("button", { name: "More" }).click();
    await expect(page.getByRole("link", { name: "Users" })).toHaveCount(0);
  });
});
