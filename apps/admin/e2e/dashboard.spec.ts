import { expect, test } from "@playwright/test";
import { expectAccessible, login, navLink } from "./helpers";

test.describe("panel shell + dashboard (phase 9 M1)", () => {
  test("login lands on the dashboard with the seeded numbers", async ({ page }) => {
    await login(page);
    await expect(page.getByRole("heading", { name: "Waiting for you" })).toBeVisible();
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

  test("on a phone what waits for you is in the first screen (phase 15 M5)", async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, "phones only");
    await login(page, "operator");
    const block = page.getByRole("list", { name: "Waiting for you" });
    await expect(page.getByRole("heading", { name: "Waiting for you" })).toBeInViewport();
    await expect(block.getByRole("link").first()).toBeInViewport();
  });

  test("the Home: at most 3 decisions, See all (N) = the To do counter, no error tile (phase 15 M5)", async ({
    page,
  }) => {
    await login(page, "operator");
    const block = page.getByRole("list", { name: "Waiting for you" });
    await expect(block.getByRole("link").first()).toBeVisible();
    expect(await block.getByRole("link").count()).toBeLessThanOrEqual(3);
    // No one-click buttons on the Home: it stays light.
    await expect(block.getByRole("button")).toHaveCount(0);
    const seeAll = page.getByRole("link", { name: /^See all \(\d+\)$/ });
    const n = Number(/\((\d+)\)/.exec((await seeAll.textContent()) ?? "")?.[1]);
    const badge = await navLink(page, "To do").first().locator(".sr-only").textContent();
    expect(n).toBe(Number(/(\d+) pending/.exec(badge ?? "")?.[1]));
    await expect(page.getByText("Errors in the period")).toHaveCount(0);
    // The chats a person is handling: one line, because the seed has one (other specs may add more).
    await expect(
      page.getByRole("link", { name: /^A person is handling \d+ chats?$/ }),
    ).toBeVisible();
    // The red line is for admins only.
    await expect(page.getByRole("link", { name: /technical errors? not reviewed/ })).toHaveCount(0);
    await seeAll.click();
    await expect(page.getByRole("heading", { name: "To do", level: 1 })).toBeVisible();
    await expectAccessible(page);
  });

  test("All caught up, short, when nothing waits (phase 15 M5)", async ({ page }) => {
    const empty = {
      counts: { total: 0, reviews: { canResolve: 0, waitingForAdmin: 0 }, alerts: 0 },
      groups: [],
      groupsTruncated: false,
      alerts: [],
    };
    await page.route("**/api/v1/admin/todo", (r) => r.fulfill({ json: empty }));
    await page.route("**/api/v1/admin/todo/summary", (r) => r.fulfill({ json: empty.counts }));
    await login(page, "operator");
    await expect(page.getByText("All caught up.")).toBeVisible();
    await expect(page.getByRole("link", { name: /^See all/ })).toHaveCount(0);
    await expectAccessible(page);
  });

  test("the navigation has ONE counter, on To do (phase 15, ADR-032)", async ({ page }) => {
    await login(page);
    await expect(
      page.getByRole("link", { name: /To do.*pending|pending.*To do/ }).first(),
    ).toBeVisible();
    // No other section carries a counter (Activity, System status: never yellow).
    await expect(
      page.getByRole("link", { name: /pending/ }).filter({ hasNotText: "To do" }),
    ).toHaveCount(0);
  });

  test("an unknown address shows 'Page not found' INSIDE the panel (phase 14 M6)", async ({
    page,
    isMobile,
  }) => {
    await login(page);
    await page.goto("/this-page-does-not-exist");
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
    // the shell is still there: navigation and the way back
    await expect(navLink(page, isMobile ? "Catalog" : "Home")).toBeVisible();
    await page.getByRole("link", { name: "Back to home" }).click();
    await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
  });

  test("the period switch reloads the data", async ({ page }) => {
    await login(page);
    await page.getByRole("button", { name: "30 days" }).click();
    await expect(page.getByText("Last 30 days")).toBeVisible();
    // phase 16 M6a: the period lives in the URL, so a refresh keeps it
    await expect(page).toHaveURL(/\/\?days=30$/);
    await page.reload();
    await expect(page.getByText("Last 30 days")).toBeVisible();
    await page.getByRole("button", { name: "14 days" }).click();
    await expect(page).toHaveURL(/\/$/);
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
