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

  test("the AI cost is marked as sample data in the public demo (phase 14)", async ({ page }) => {
    await login(page);
    const card = page
      .locator("section, div")
      .filter({ has: page.getByRole("heading", { name: /AI cost per day/ }) })
      .last();
    await expect(card.getByText("Sample data")).toBeVisible();
    await expect(page.getByText(/daily limit/)).toHaveCount(0);
  });

  test("on a phone the four pending figures fit in the first screen (phase 14)", async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, "phones only");
    await login(page);
    for (const label of [
      "Pending reviews",
      "Open alerts",
      "Chats handled by a person",
      "Errors in the period",
    ]) {
      await expect(page.getByText(label, { exact: true })).toBeInViewport({ ratio: 1 });
    }
  });

  test("the navigation shows how many reviews wait for a person (phase 14)", async ({ page }) => {
    await login(page);
    await expect(
      page.getByRole("link", { name: /Reviews.*pending|pending.*Reviews/ }).first(),
    ).toBeVisible();
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
