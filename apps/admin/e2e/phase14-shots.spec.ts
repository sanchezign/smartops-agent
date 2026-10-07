import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { test, type Page } from "@playwright/test";
import { E2E } from "./env";

/**
 * Phase 14 before/after screenshots (NOT an assertion suite): every screen, English, light and
 * dark, per project, into e2e/screens/phase-14/<SHOTS>/ (gitignored). axe findings (WCAG 2.1
 * A/AA) go to axe-<project>.json next to the images.
 *   SHOTS=M1-after E2E_IPHONE_CHROMIUM=1 pnpm --filter @smartops/admin e2e phase14-shots.spec.ts \
 *     --project desktop --project iphone-chromium
 * Selectors never depend on the panel language.
 */
const LABEL = process.env.SHOTS;
test.skip(!LABEL, "set SHOTS=<label> to take the phase 14 screenshots");

const ready = async (page: Page) => {
  // (never "networkidle": the real-time stream stays open, ADR-020)
  await page.getByRole("heading", { level: 1 }).first().waitFor();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(1_000);
};

async function signIn(page: Page, who: "operator" | "admin") {
  await page.goto("/login");
  await page.locator("button[type=submit]:not([disabled])").waitFor();
  await page.locator("input[name=email]").fill(E2E[who].email);
  await page.locator("input[name=password]").fill(E2E[who].password);
  await page.locator("button[type=submit]").click();
  await page.waitForURL((url) => url.pathname === "/");
  await ready(page);
}

for (const scheme of ["light", "dark"] as const) {
  test(`screens ${scheme}`, async ({ page, context, isMobile }, info) => {
    test.setTimeout(420_000);
    const dir = `e2e/screens/phase-14/${LABEL}/${info.project.name}`;
    mkdirSync(dir, { recursive: true });
    const findings: Record<string, string[]> = {};
    let n = 0;
    const shoot = async (name: string, fullPage = true) => {
      const file = `${scheme}-${String(++n).padStart(2, "0")}-${name}.png`;
      await page.screenshot({ path: `${dir}/${file}`, fullPage });
      const axe = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      findings[file] = axe.violations.map(
        (v) =>
          `${v.id}: ${v.help} → ${v.nodes
            .slice(0, 5)
            .map((x) => `${x.target.join(" ")} ${x.any[0]?.message ?? ""}`.trim())
            .join(" | ")}`,
      );
    };
    if (!isMobile) await page.setViewportSize({ width: 1440, height: 900 });
    await context.addCookies([{ name: "smartops_locale", value: "en", url: E2E.panelUrl }]);
    await page.emulateMedia({ colorScheme: scheme });

    await page.goto("/login");
    await page.locator("input[name=email]").waitFor();
    await page.waitForTimeout(900);
    await shoot("login");

    await signIn(page, "operator");
    await shoot("home");
    await page.goto("/reviews");
    await ready(page);
    await shoot("reviews");
    const hrefs = await page
      .locator('main a[href^="/reviews/"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute("href")!));
    for (const [i, href] of [...new Set(hrefs)].slice(0, 3).entries()) {
      await page.goto(href);
      await ready(page);
      await shoot(`review-${i + 1}`);
    }
    await page.goto("/conversations");
    await ready(page);
    await shoot("inbox");
    await page
      .locator('main a[href^="/conversations/"]')
      .filter({ hasText: "Luis" })
      .first()
      .click();
    await page.locator("section[aria-label]").first().waitFor();
    await ready(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);
    await shoot("chat", false);
    await page.goto("/conversations/opted-out");
    await ready(page);
    await shoot("opted-out");
    await page.goto("/catalog");
    await ready(page);
    await shoot("catalog", false);
    await page.locator("input[type=search]").fill("tornillo 6mm");
    await page.waitForTimeout(700);
    await page.locator('main a[href^="/catalog/"]').first().click();
    await ready(page);
    await shoot("product");
    for (const path of ["/alerts", "/rules", "/try"]) {
      await page.goto(path);
      await ready(page);
      await shoot(path.slice(1));
    }
    await page.goto("/this-page-does-not-exist");
    await page.waitForTimeout(900);
    await shoot("not-found");

    await context.clearCookies();
    await context.addCookies([{ name: "smartops_locale", value: "en", url: E2E.panelUrl }]);
    await signIn(page, "admin");
    await page.goto("/users");
    await ready(page);
    await shoot("users");

    writeFileSync(`${dir}/axe-${scheme}.json`, JSON.stringify(findings, null, 2));
  });
}

/**
 * Phone only: the REAL viewport (no fullPage), at the top and after scrolling to the bottom of
 * the Home. A fullPage capture stitches a position:fixed bar in the middle of the page; this is
 * what the person actually sees.
 */
test("phone viewport, top and bottom of the Home", async ({ page, context, isMobile }, info) => {
  test.skip(!isMobile, "phones only");
  const dir = `e2e/screens/phase-14/${LABEL}/${info.project.name}`;
  mkdirSync(dir, { recursive: true });
  await context.addCookies([{ name: "smartops_locale", value: "en", url: E2E.panelUrl }]);
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await signIn(page, "operator");
    await page.screenshot({ path: `${dir}/viewport-${scheme}-home-top.png` });
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${dir}/viewport-${scheme}-home-bottom.png` });
  }
});
