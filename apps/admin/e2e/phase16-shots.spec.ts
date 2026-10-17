import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { test, type Page } from "@playwright/test";
import { E2E } from "./env";

/**
 * Phase 16 screenshots (NOT an assertion suite), into $SHOTS_DIR/<SHOTS>/<project>/ (default
 * e2e/screens/phase-16, gitignored; the owner's review copy lives OUTSIDE the repo):
 *   SHOTS=m0-before SHOTS_DIR=C:/dev/smartops-phase16-shots E2E_IPHONE_CHROMIUM=1 \
 *     pnpm --filter @smartops/admin e2e phase16-shots.spec.ts --project desktop --project iphone-chromium
 * Viewer: the public demo's operator. English and Spanish, light and dark. The chat screens also
 * record where the reply box sits against the viewport (chat-geometry-*.json): the M1 diagnosis.
 * Selectors never depend on the panel language.
 */
const LABEL = process.env.SHOTS;
const ROOT = process.env.SHOTS_DIR ?? "e2e/screens/phase-16";
test.skip(!LABEL, "set SHOTS=<label> to take the phase 16 screenshots");

// SHOTS_LOCALES=en SHOTS_SCHEMES=light,dark narrow the run (default: all four combinations).
const pick = <T extends string>(all: readonly T[], env: string | undefined) =>
  env ? all.filter((x) => env.split(",").includes(x)) : all;
const LOCALES = pick(["en", "es"] as const, process.env.SHOTS_LOCALES);
const SCHEMES = pick(["light", "dark"] as const, process.env.SHOTS_SCHEMES);
// SHOTS_SET=todo: only the M2 set (To do for the demo operator and the admin); SHOTS_SET=money: the M3 set
// (Catalog, a product, To do and Rules; run it with E2E_CONTENT_LANGUAGE=es for the Spanish content);
// default: the panel.
const SET = process.env.SHOTS_SET ?? "panel";

const ready = async (page: Page) => {
  // (never "networkidle": the real-time stream stays open, ADR-020)
  await page.getByRole("heading", { level: 1 }).first().waitFor();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(1_000);
};

async function signIn(page: Page, who: "operator" | "admin" = "operator") {
  await page.goto("/login");
  await page.locator("button[type=submit]:not([disabled])").waitFor();
  await page.locator("input[name=email]").fill(E2E[who].email);
  await page.locator("input[name=password]").fill(E2E[who].password);
  await page.locator("button[type=submit]").click();
  await page.waitForURL((url) => url.pathname === "/");
  await ready(page);
}

for (const locale of LOCALES) {
  for (const scheme of SCHEMES) {
    test(`panel ${locale} ${scheme}`, async ({ page, context, isMobile }, info) => {
      test.skip(SET !== "panel", "SHOTS_SET");
      test.setTimeout(300_000);
      const dir = `${ROOT}/${LABEL}/${info.project.name}`;
      mkdirSync(dir, { recursive: true });
      const prefix = `${locale}-${scheme}`;
      const findings: Record<string, string[]> = {};
      const geometry: Record<string, unknown> = {};
      let n = 0;
      const shoot = async (name: string, fullPage = true) => {
        const file = `${prefix}-${String(++n).padStart(2, "0")}-${name}.png`;
        await page.screenshot({ path: `${dir}/${file}`, fullPage });
        const axe = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze();
        findings[file] = axe.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`);
      };
      if (!isMobile) await page.setViewportSize({ width: 1440, height: 900 });
      await context.addCookies([{ name: "smartops_locale", value: locale, url: E2E.panelUrl }]);
      await page.emulateMedia({ colorScheme: scheme });

      await signIn(page);
      await shoot("home");
      await page.goto("/todo");
      await ready(page);
      await shoot("todo");
      await page.goto("/conversations");
      await ready(page);
      await shoot("conversations");

      // Chats: the shortest one (fewest messages) and the longest, for the reply-box geometry.
      const links = await page
        .locator('main a[href^="/conversations/"]:not([href$="opted-out"])')
        .evaluateAll((els) => els.map((e) => e.getAttribute("href")!));
      const counts: { href: string; count: number }[] = [];
      for (const href of links) {
        await page.goto(href);
        await ready(page);
        counts.push({ href, count: await page.locator("main section[aria-label] > *").count() });
      }
      counts.sort((a, b) => a.count - b.count);
      const picks = [
        ["chat-short", counts[0]],
        ["chat-long", counts.at(-1)],
      ] as const;
      for (const [name, pick] of picks) {
        if (!pick) continue;
        await page.goto(pick.href);
        await ready(page);
        await page.waitForTimeout(800);
        const box = await page.locator("main textarea").first().boundingBox();
        const view = page.viewportSize();
        geometry[name] = {
          href: pick.href,
          children: pick.count,
          viewportHeight: view?.height,
          composerTop: box?.y,
          composerBottom: box ? box.y + box.height : null,
          gapBelowComposer: box && view ? view.height - (box.y + box.height) : null,
        };
        await shoot(name, false);
      }

      await page.goto("/catalog");
      await ready(page);
      await shoot("catalog");
      await page.goto("/activity");
      await ready(page);
      await shoot("activity");

      // M1: the inbox filtered by "Needs a reply" (the second filter button), at the END so the
      // numbering of the shots above does not move.
      await page.goto("/conversations");
      await ready(page);
      await page.getByRole("group").getByRole("button").nth(1).click();
      await page.waitForTimeout(600);
      await shoot("conversations-needs-reply");

      writeFileSync(`${dir}/axe-${prefix}.json`, JSON.stringify(findings, null, 2));
      writeFileSync(`${dir}/chat-geometry-${prefix}.json`, JSON.stringify(geometry, null, 2));
    });
  }
}

/**
 * M2 (ADR-034): To do in the public demo, for the demo operator and for the admin: the list, the
 * first review that only an admin resolves in a real installation (with its note), and the empty
 * To do (API answer mocked) with "Try the system" and "Reset demo".
 */
const EMPTY = {
  counts: { total: 0, reviews: { canResolve: 0, waitingForAdmin: 0 }, alerts: 0 },
  groups: [],
  groupsTruncated: false,
  alerts: [],
};
for (const who of ["operator", "admin"] as const)
  for (const locale of LOCALES)
    for (const scheme of SCHEMES)
      test(`todo ${who} ${locale} ${scheme}`, async ({ page, context, isMobile }, info) => {
        test.skip(SET !== "todo", "SHOTS_SET");
        test.setTimeout(240_000);
        const dir = `${ROOT}/${LABEL}/${info.project.name}`;
        mkdirSync(dir, { recursive: true });
        const prefix = `${who === "operator" ? "operator-demo" : "admin"}-${locale}-${scheme}`;
        const findings: Record<string, string[]> = {};
        let n = 0;
        const shoot = async (name: string, fullPage = true) => {
          const file = `${prefix}-${String(++n).padStart(2, "0")}-${name}.png`;
          await page.screenshot({ path: `${dir}/${file}`, fullPage });
          const axe = await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
            .analyze();
          findings[file] = axe.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`);
        };
        if (!isMobile) await page.setViewportSize({ width: 1440, height: 900 });
        await context.addCookies([{ name: "smartops_locale", value: locale, url: E2E.panelUrl }]);
        await page.emulateMedia({ colorScheme: scheme });
        await signIn(page, who);
        await page.goto("/todo");
        await ready(page);
        await shoot("todo");
        // the seeded suspicious message: a whole-list gate (admin-only in a real installation)
        const href = await page
          .locator('main a[href^="/reviews/"]')
          .filter({ hasText: /Suspicious message|Mensaje sospechoso/ })
          .first()
          .getAttribute("href");
        if (href) {
          await page.goto(href);
          await ready(page);
          await shoot("review-admin-only");
        }
        await page.route("**/api/v1/admin/todo", (r) => r.fulfill({ json: EMPTY }));
        await page.route("**/api/v1/admin/todo/summary", (r) => r.fulfill({ json: EMPTY.counts }));
        await page.goto("/todo");
        await ready(page);
        await shoot("todo-empty");
        writeFileSync(`${dir}/axe-${prefix}.json`, JSON.stringify(findings, null, 2));
      });

/**
 * M3 (ADR-035): the catalog currency everywhere. Catalog, one product with its price history, To do (with
 * the "currency changed" question) and Rules, for the demo operator, in both panel languages.
 */
for (const locale of LOCALES)
  for (const scheme of SCHEMES)
    test(`money ${locale} ${scheme}`, async ({ page, context, isMobile }, info) => {
      test.skip(SET !== "money", "SHOTS_SET");
      test.setTimeout(240_000);
      const dir = `${ROOT}/${LABEL}/${info.project.name}`;
      mkdirSync(dir, { recursive: true });
      const prefix = `operator-${locale}-${scheme}`;
      const findings: Record<string, string[]> = {};
      let n = 0;
      const shoot = async (name: string) => {
        const file = `${prefix}-${String(++n).padStart(2, "0")}-${name}.png`;
        await page.screenshot({ path: `${dir}/${file}`, fullPage: true });
        const axe = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze();
        findings[file] = axe.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`);
      };
      if (!isMobile) await page.setViewportSize({ width: 1440, height: 900 });
      await context.addCookies([{ name: "smartops_locale", value: locale, url: E2E.panelUrl }]);
      await page.emulateMedia({ colorScheme: scheme });
      await signIn(page);
      await page.goto("/catalog");
      await ready(page);
      await shoot("catalog");
      const product = page.locator('main a[href^="/catalog/"]').first();
      if ((await product.count()) > 0) {
        await product.click();
        await ready(page);
        await shoot("product");
      }
      await page.goto("/todo");
      await ready(page);
      await shoot("todo");
      await page.goto("/rules");
      await ready(page);
      await shoot("rules");
      writeFileSync(`${dir}/axe-${prefix}.json`, JSON.stringify(findings, null, 2));
    });

/**
 * M6a (Web Interface Guidelines fixes), what changed and the other sets do not show: filters opened from the URL
 * (Conversations, Catalog, Home), a line review with its inputs (44 px on a phone), Rules (native select, curly
 * quotes on "Save “…”"), the chat's actions menu ("…" on the options that open a dialog) and, as admin, the
 * rename-supplier dialog.
 */
for (const locale of LOCALES)
  for (const scheme of SCHEMES)
    test(`m6a ${locale} ${scheme}`, async ({ page, context, isMobile }, info) => {
      test.skip(SET !== "m6a", "SHOTS_SET");
      test.setTimeout(300_000);
      const dir = `${ROOT}/${LABEL}/${info.project.name}`;
      mkdirSync(dir, { recursive: true });
      const prefix = `${locale}-${scheme}`;
      const findings: Record<string, string[]> = {};
      let n = 0;
      const shoot = async (name: string, fullPage = true) => {
        const file = `${prefix}-${String(++n).padStart(2, "0")}-${name}.png`;
        await page.screenshot({ path: `${dir}/${file}`, fullPage });
        const axe = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze();
        findings[file] = axe.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`);
      };
      if (!isMobile) await page.setViewportSize({ width: 1440, height: 900 });
      await context.addCookies([{ name: "smartops_locale", value: locale, url: E2E.panelUrl }]);
      await page.emulateMedia({ colorScheme: scheme });
      await signIn(page);
      await page.goto("/conversations?filter=needs_reply");
      await ready(page);
      await shoot("conversations-url-filter");
      await page.goto("/catalog?availability=available");
      await ready(page);
      await shoot("catalog-url-filter");
      await page.goto("/?days=30");
      await ready(page);
      await shoot("home-30-days");
      // a line review with inputs: the product-match question ("Is “Washer” the same product…")
      await page.goto("/todo");
      await ready(page);
      const line = page
        .locator('main a[href^="/reviews/"]')
        .filter({ hasText: /Washer|Arandela/ })
        .first();
      if ((await line.count()) > 0) {
        await page.goto((await line.getAttribute("href"))!);
        await ready(page);
        await shoot("review-line");
      }
      await page.goto("/rules");
      await ready(page);
      await shoot("rules");
      // the chat's actions menu, open
      await page.goto("/conversations");
      await ready(page);
      await page.locator('main a[href^="/conversations/"]:not([href$="opted-out"])').first().click();
      await ready(page);
      const more = page.getByRole("button", { name: /More actions|Más acciones/ });
      if ((await more.count()) > 0) {
        await more.click();
        await page.getByRole("menu").waitFor();
        await shoot("chat-menu", false);
        await page.keyboard.press("Escape");
      }
      // as admin: the rename dialog of a supplier (Catalog)
      await page.context().clearCookies();
      await context.addCookies([{ name: "smartops_locale", value: locale, url: E2E.panelUrl }]);
      await signIn(page, "admin");
      await page.goto("/catalog");
      await ready(page);
      await page.getByRole("combobox", { name: /^(Supplier|Proveedor)$/ }).click();
      await page.getByRole("option").nth(1).click();
      await page.getByRole("button", { name: /Rename|Renombrar/ }).click();
      await page.getByRole("dialog").waitFor();
      await page.waitForTimeout(400);
      await shoot("rename-dialog", false);
      writeFileSync(`${dir}/axe-${prefix}.json`, JSON.stringify(findings, null, 2));
    });

/**
 * M4 (ADR-033): the K2 theme on Home and To do, for the demo operator.
 */
for (const locale of LOCALES)
  for (const scheme of SCHEMES)
    test(`theme ${locale} ${scheme}`, async ({ page, context, isMobile }, info) => {
      test.skip(SET !== "theme", "SHOTS_SET");
      test.setTimeout(240_000);
      const dir = `${ROOT}/${LABEL}/${info.project.name}`;
      mkdirSync(dir, { recursive: true });
      const prefix = `operator-${locale}-${scheme}`;
      const findings: Record<string, string[]> = {};
      let n = 0;
      const shoot = async (name: string) => {
        const file = `${prefix}-${String(++n).padStart(2, "0")}-${name}.png`;
        await page.screenshot({ path: `${dir}/${file}`, fullPage: true });
        const axe = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze();
        findings[file] = axe.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`);
      };
      if (!isMobile) await page.setViewportSize({ width: 1440, height: 900 });
      await context.addCookies([{ name: "smartops_locale", value: locale, url: E2E.panelUrl }]);
      await page.emulateMedia({ colorScheme: scheme });
      await signIn(page);
      await page.goto("/");
      await ready(page);
      await shoot("home");
      await page.goto("/todo");
      await ready(page);
      await shoot("todo");
      writeFileSync(`${dir}/axe-${prefix}.json`, JSON.stringify(findings, null, 2));
    });
