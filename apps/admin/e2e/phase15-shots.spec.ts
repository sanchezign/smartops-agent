import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { test, type Page } from "@playwright/test";
import { E2E } from "./env";

/**
 * Phase 15 before/after screenshots (NOT an assertion suite): the screens the panel triage touches
 * (ADR-032), English and Spanish, light and dark, per project, as operator and as admin, into
 * $SHOTS_DIR/<SHOTS>/<project>/ (default e2e/screens/phase-15, gitignored; the owner's review copy
 * lives OUTSIDE the repo). axe findings (WCAG 2.1 A/AA) go to axe-<locale>-<scheme>.json.
 *   SHOTS=M2-after SHOTS_DIR=C:/dev/smartops-phase15-shots E2E_IPHONE_CHROMIUM=1 \
 *     pnpm --filter @smartops/admin e2e phase15-shots.spec.ts --project desktop --project iphone-chromium
 * Selectors never depend on the panel language. The same paths work before and after phase 15:
 * /reviews and /alerts become redirects to /todo and /activity in M2.
 */
const LABEL = process.env.SHOTS;
const ROOT = process.env.SHOTS_DIR ?? "e2e/screens/phase-15";
test.skip(!LABEL, "set SHOTS=<label> to take the phase 15 screenshots");

const LOCALES = ["en", "es"] as const;
const SCHEMES = ["light", "dark"] as const;

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

function shooter(page: Page, dir: string, prefix: string) {
  const findings: Record<string, string[]> = {};
  let n = 0;
  const shoot = async (name: string, fullPage = true) => {
    const file = `${prefix}-${String(++n).padStart(2, "0")}-${name}.png`;
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
  const save = () => writeFileSync(`${dir}/axe-${prefix}.json`, JSON.stringify(findings, null, 2));
  return { shoot, save };
}

/** The pending list (before phase 15: /reviews; from M2 on, /reviews redirects to /todo). */
const LIST = "/reviews";

/** The resolved history: the old status filter before M2, the "Resolved" view after. */
async function openHistory(page: Page) {
  await page.goto(LIST);
  await ready(page);
  const resolved = page.locator('main a[href="/todo/resolved"]');
  if (await resolved.count()) {
    await resolved.first().click();
  } else {
    // Before phase 15: the second filter group (status), second button (approved).
    await page.locator("main [role=group]").nth(1).locator("button").nth(1).click();
  }
  await page.waitForTimeout(1_200);
}

for (const locale of LOCALES) {
  for (const scheme of SCHEMES) {
    test(`triage screens ${locale} ${scheme}`, async ({ page, context, isMobile }, info) => {
      test.setTimeout(420_000);
      const dir = `${ROOT}/${LABEL}/${info.project.name}`;
      mkdirSync(dir, { recursive: true });
      const { shoot, save } = shooter(page, dir, `${locale}-${scheme}`);
      if (!isMobile) await page.setViewportSize({ width: 1440, height: 900 });
      await context.addCookies([{ name: "smartops_locale", value: locale, url: E2E.panelUrl }]);
      await page.emulateMedia({ colorScheme: scheme });

      // Operator (the public demo's account)
      await signIn(page, "operator");
      await shoot("operator-home");
      await page.goto(LIST);
      await ready(page);
      await shoot("operator-todo");
      const hrefs = await page
        .locator('main a[href^="/reviews/"]')
        .evaluateAll((els) => els.map((e) => e.getAttribute("href")!));
      for (const [i, href] of [...new Set(hrefs)].slice(0, 3).entries()) {
        await page.goto(href);
        await ready(page);
        await shoot(`operator-review-${i + 1}`);
      }
      await openHistory(page);
      await shoot("operator-resolved");
      await page.goto("/alerts");
      await ready(page);
      await shoot("operator-activity");

      // Admin
      await context.clearCookies();
      await context.addCookies([{ name: "smartops_locale", value: locale, url: E2E.panelUrl }]);
      await signIn(page, "admin");
      await shoot("admin-home");
      await page.goto(LIST);
      await ready(page);
      await shoot("admin-todo");
      await page.goto("/alerts");
      await ready(page);
      await shoot("admin-activity");
      save();
    });
  }
}

/** Phone only: what the person actually sees (no fullPage) — the Home and the pending list. */
test("phone viewport, Home and the pending list", async ({ page, context, isMobile }, info) => {
  test.skip(!isMobile, "phones only");
  test.setTimeout(240_000);
  const dir = `${ROOT}/${LABEL}/${info.project.name}`;
  mkdirSync(dir, { recursive: true });
  for (const locale of LOCALES) {
    for (const scheme of SCHEMES) {
      await context.clearCookies();
      await context.addCookies([{ name: "smartops_locale", value: locale, url: E2E.panelUrl }]);
      await page.emulateMedia({ colorScheme: scheme });
      await signIn(page, "operator");
      await page.screenshot({ path: `${dir}/viewport-${locale}-${scheme}-home-top.png` });
      await page.goto(LIST);
      await ready(page);
      await page.screenshot({ path: `${dir}/viewport-${locale}-${scheme}-todo-top.png` });
    }
  }
});
