import { test, type Page } from "@playwright/test";
import { E2E } from "./env";
import { expectAccessible, login } from "./helpers";

/**
 * Accessibility of EVERY screen, in light and dark (phase 14 M7, ADR-029): WCAG 2.1 A/AA with axe,
 * zero violations, on every browser project. The look of the panel (yellow only for what waits
 * for a person, framed rows, tokens) is held up by two nets: test/contrast.test.ts checks the
 * palette pair by pair, this spec checks what is really rendered. English; the Spanish pass is
 * i18n-es.spec.ts. Read-only: it never changes the shared demo data.
 */

const SCHEMES = ["light", "dark"] as const;

async function ready(page: Page) {
  // (never "networkidle": the real-time stream stays open, ADR-020)
  await page.getByRole("heading", { level: 1 }).first().waitFor();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(700);
}

for (const scheme of SCHEMES) {
  test.describe(`accessibility, ${scheme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
    });

    test("login", async ({ page }) => {
      await page.goto("/login");
      await page.locator("input[name=email]").waitFor();
      await expectAccessible(page);
    });

    test("operator screens: home, lists, details, chat, rules, try", async ({ page }) => {
      test.setTimeout(240_000);
      await login(page, "operator");
      await ready(page);
      await expectAccessible(page); // Home

      await page.goto("/reviews");
      await ready(page);
      await expectAccessible(page);
      const hrefs = await page
        .locator('main a[href^="/reviews/"]')
        .evaluateAll((els) => els.map((e) => e.getAttribute("href")!));
      for (const href of [...new Set(hrefs)].slice(0, 3)) {
        await page.goto(href);
        await ready(page);
        await expectAccessible(page);
      }

      await page.goto("/conversations");
      await ready(page);
      await expectAccessible(page);
      await page
        .locator('main a[href^="/conversations/"]')
        .filter({ hasText: "Louis" })
        .first()
        .click();
      await page.locator("section[aria-label]").first().waitFor();
      await ready(page);
      await expectAccessible(page);

      for (const path of ["/conversations/opted-out", "/catalog", "/alerts", "/rules", "/try"]) {
        await page.goto(path);
        await ready(page);
        await expectAccessible(page);
      }

      await page.goto("/catalog");
      await ready(page);
      await page.locator("input[type=search]").fill("hex bolt");
      await page.waitForTimeout(700);
      await page.locator('main a[href^="/catalog/"]').first().click();
      await ready(page);
      await expectAccessible(page); // Product

      await page.goto("/this-page-does-not-exist");
      await ready(page);
      await expectAccessible(page); // 404 inside the panel
    });

    test("administrator screen: users", async ({ page, context }) => {
      await context.addCookies([{ name: "smartops_locale", value: "en", url: E2E.panelUrl }]);
      await login(page, "admin");
      await page.goto("/users");
      await ready(page);
      await expectAccessible(page);
    });
  });
}
