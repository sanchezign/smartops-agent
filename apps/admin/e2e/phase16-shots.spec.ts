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

const ready = async (page: Page) => {
  // (never "networkidle": the real-time stream stays open, ADR-020)
  await page.getByRole("heading", { level: 1 }).first().waitFor();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(1_000);
};

async function signIn(page: Page) {
  await page.goto("/login");
  await page.locator("button[type=submit]:not([disabled])").waitFor();
  await page.locator("input[name=email]").fill(E2E.operator.email);
  await page.locator("input[name=password]").fill(E2E.operator.password);
  await page.locator("button[type=submit]").click();
  await page.waitForURL((url) => url.pathname === "/");
  await ready(page);
}

for (const locale of LOCALES) {
  for (const scheme of SCHEMES) {
    test(`panel ${locale} ${scheme}`, async ({ page, context, isMobile }, info) => {
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
