import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test, type Page } from "@playwright/test";
import { E2E } from "./env";

/**
 * Phase 15 before/after screenshots (NOT an assertion suite): the screens the panel triage touches
 * (ADR-032), English and Spanish, light and dark, per project, into
 * $SHOTS_DIR/<SHOTS>/<project>/ (default e2e/screens/phase-15, gitignored; the owner's review copy
 * lives OUTSIDE the repo). axe findings (WCAG 2.1 A/AA) go to axe-<viewer>-<locale>-<scheme>.json.
 *
 * Viewers: the public demo's operator and an admin (the suite's DEMO_MODE), and a regular
 * operator without the demo rules (run again with E2E_DEMO_MODE=off: ADR-030 off):
 *   SHOTS=M2-after SHOTS_DIR=C:/dev/smartops-phase15-shots E2E_IPHONE_CHROMIUM=1 \
 *     pnpm --filter @smartops/admin e2e phase15-shots.spec.ts --project desktop --project iphone-chromium
 *   (+ E2E_DEMO_MODE=off for the regular operator)
 * Selectors never depend on the panel language. "All caught up" is the To do screen with an
 * empty answer of the API (route mocked): no viewer of the seeded demo has nothing to do.
 */
const LABEL = process.env.SHOTS;
const ROOT = process.env.SHOTS_DIR ?? "e2e/screens/phase-15";
const DEMO = process.env.E2E_DEMO_MODE !== "off";
test.skip(!LABEL, "set SHOTS=<label> to take the phase 15 screenshots");

const LOCALES = ["en", "es"] as const;
const SCHEMES = ["light", "dark"] as const;
const VIEWERS = DEMO
  ? ([
      ["operator-demo", "operator"],
      ["admin", "admin"],
    ] as const)
  : ([["operator", "operator"]] as const);

// `pg` lives in the API package: borrow it to create the admin's unreviewed error (M5).
const pg = createRequire(resolve(process.cwd(), "../api/package.json"))("pg") as {
  Client: new (options: { connectionString: string }) => {
    connect(): Promise<void>;
    query(sql: string, values?: unknown[]): Promise<unknown>;
    end(): Promise<void>;
  };
};

/** One unreviewed technical error, for the admin's red line on the Home (created once). */
async function ensureUnreviewedError() {
  const db = new pg.Client({ connectionString: E2E.databaseUrl });
  await db.connect();
  try {
    await db.query(
      `INSERT INTO alerts (id, type, severity, status, title, payload, created_at, updated_at)
       SELECT gen_random_uuid(), 'integration_error', 'critical', 'open', $1,
              '{"reason":"n8n_delivery_failed"}', now(), now()
        WHERE NOT EXISTS (SELECT 1 FROM alerts WHERE title = $1)`,
      ["phase 15 screenshots: n8n delivery failed"],
    );
  } finally {
    await db.end();
  }
}

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

/** The pending list: /reviews before phase 15, a redirect to /todo from M2 on. */
const LIST = "/reviews";

async function unfoldWaiting(page: Page) {
  const summary = page.locator("main details summary");
  if ((await summary.count()) > 0) {
    await summary.click();
    await page.waitForTimeout(400);
    return true;
  }
  return false;
}

const EMPTY = {
  counts: { total: 0, reviews: { canResolve: 0, waitingForAdmin: 0 }, alerts: 0 },
  groups: [],
  groupsTruncated: false,
  alerts: [],
};

for (const [viewer, who] of VIEWERS) {
  for (const locale of LOCALES) {
    for (const scheme of SCHEMES) {
      test(`triage ${viewer} ${locale} ${scheme}`, async ({ page, context, isMobile }, info) => {
        test.setTimeout(420_000);
        const dir = `${ROOT}/${LABEL}/${info.project.name}`;
        mkdirSync(dir, { recursive: true });
        const { shoot, save } = shooter(page, dir, `${viewer}-${locale}-${scheme}`);
        if (!isMobile) await page.setViewportSize({ width: 1440, height: 900 });
        await context.addCookies([{ name: "smartops_locale", value: locale, url: E2E.panelUrl }]);
        await page.emulateMedia({ colorScheme: scheme });

        if (who === "admin") await ensureUnreviewedError();
        await signIn(page, who);
        await shoot("home");
        await page.goto(LIST);
        await ready(page);
        await shoot("todo");
        if (await unfoldWaiting(page)) await shoot("todo-waiting-unfolded");
        const hrefs = await page
          .locator('main a[href^="/reviews/"]')
          .evaluateAll((els) => els.map((e) => e.getAttribute("href")!));
        if (hrefs[0]) {
          await page.goto(hrefs[0]);
          await ready(page);
          await shoot("review");
        }
        // M3: a decision that can be taken in one click, opened: its question and what approving does.
        await page.goto("/todo");
        await ready(page);
        const quick = page.locator('main [role="group"]').first();
        if ((await quick.count()) > 0) {
          await quick.locator("xpath=..").locator('a[href^="/reviews/"]').first().click();
          await ready(page);
          await shoot("review-one-click-kind");
        }
        await page.goto("/todo/resolved");
        await ready(page);
        await shoot("resolved");
        await page.goto("/alerts"); // → /activity from M2 on
        await ready(page);
        await shoot("activity");
        await page.goto("/system");
        if (DEMO || who === "admin") {
          await ready(page);
          await shoot("system");
        } else {
          // A regular operator: not in its menu, and the page says it is not for this role.
          await page.locator("main").getByRole("img").or(page.locator("main p")).first().waitFor();
          await page.waitForTimeout(1_000);
          await shoot("system-not-allowed");
        }
        if (isMobile) {
          // The bottom bar and its "More" sheet (what moved out of the first four).
          await page.goto("/");
          await ready(page);
          await page.getByRole("navigation").last().locator("button").last().click();
          await page.waitForTimeout(600);
          await shoot("more-sheet", false);
        }
        // All caught up (the API answer mocked: see the header).
        await page.route("**/api/v1/admin/todo", (r) => r.fulfill({ json: EMPTY }));
        await page.route("**/api/v1/admin/todo/summary", (r) => r.fulfill({ json: EMPTY.counts }));
        await page.goto("/todo");
        await ready(page);
        await shoot("todo-all-caught-up");
        await page.goto("/");
        await ready(page);
        await shoot("home-all-caught-up");
        save();
      });
    }
  }
}

/** Phone only: what the person actually sees (no fullPage) — the Home and To do. */
test("phone viewport, Home and To do", async ({ page, context, isMobile }, info) => {
  test.skip(!isMobile, "phones only");
  test.setTimeout(300_000);
  const dir = `${ROOT}/${LABEL}/${info.project.name}`;
  mkdirSync(dir, { recursive: true });
  for (const [viewer, who] of VIEWERS) {
    for (const locale of LOCALES) {
      for (const scheme of SCHEMES) {
        await context.clearCookies();
        await context.addCookies([{ name: "smartops_locale", value: locale, url: E2E.panelUrl }]);
        await page.emulateMedia({ colorScheme: scheme });
        await signIn(page, who);
        const prefix = `${dir}/viewport-${viewer}-${locale}-${scheme}`;
        await page.screenshot({ path: `${prefix}-home-top.png` });
        await page.goto(LIST);
        await ready(page);
        await page.screenshot({ path: `${prefix}-todo-top.png` });
      }
    }
  }
});
