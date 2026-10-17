import AxeBuilder from "@axe-core/playwright";
import { errors, expect, type Page } from "@playwright/test";
import { E2E } from "./env";

export async function login(page: Page, who: "operator" | "admin" = "admin") {
  const creds = E2E[who];
  await page.goto("/login");
  // The submit button is disabled until the page hydrated; filling before that can lose the
  // value on WebKit (CI iPhone runs: "Enter a valid email address" with an empty field).
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
  await page.getByLabel("Email").fill(creds.email);
  await page.getByLabel("Password").fill(creds.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
}

/**
 * WCAG 2.1 A/AA checks (axe) on the current page, measured on a settled page:
 * - every FINITE animation or transition has finished. Mid-fade, axe blends the text with what is
 *   behind and reports a contrast no user sees for more than a moment: toasts (phase 11, CI) and the
 *   dialogs' fade + zoom, which reduced motion does not cancel (phase 16: 4.46 on the khaki button of
 *   an opening alert dialog, 4.53 once open). Infinite ones (spinners) are ignored. Then a rendered frame, so the
 *   computed style is the end state (WebKit; see nextFrames).
 * - the document has its title. On a client navigation Next.js takes the <title> out while the new
 *   route's metadata arrives (~300 ms measured on WebKit, phase 16); axe in that window reports
 *   document-title (a flaky test since at least 2026-10-06, on Pixel and iPhone).
 * Each wait has a timeout; when it runs out the check goes on and axe reports what it finds (a title
 * that never comes back IS a document-title violation), so nothing real is hidden.
 */
export async function expectAccessible(page: Page) {
  await settle(page, () =>
    document
      .getAnimations()
      .every(
        (a) => a.playState !== "running" || a.effect?.getComputedTiming().endTime === Infinity,
      ),
  );
  await nextFrames(page);
  await settle(page, () => !!document.head.querySelector("title")?.textContent?.trim());
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  // Phase 16 M6b: the best-practice rule "region" (all content inside a landmark) runs on every screen EXCEPT
  // while a menu or dialog is open: Radix hides everything outside it with aria-hidden, so axe cannot see
  // <main> and flags the rest (a false positive; docs/testing.md, "Accessibility checks").
  const modalOpen =
    (await page.locator('[role="menu"], [role="dialog"], [role="alertdialog"]').count()) > 0;
  const landmarks = modalOpen
    ? { violations: [] }
    : await new AxeBuilder({ page }).withRules(["region"]).analyze();
  expect(
    [...results.violations, ...landmarks.violations].map(
      (v) => `${v.id}: ${v.help} → ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
    ),
  ).toEqual([]);
}

/** Waits up to 5 s for `condition`; on timeout it returns and lets axe measure the page as it is. */
async function settle(page: Page, condition: () => boolean) {
  try {
    await page.waitForFunction(condition, undefined, { timeout: 5_000 });
  } catch (error) {
    if (!(error instanceof errors.TimeoutError)) throw error;
  }
}

/**
 * WebKit (phase 16, measured): an animation reads "finished" as soon as its time has passed, but the
 * computed style keeps the last frame rendered — up to ~550 ms without a frame after a dialog opened,
 * opacity 0.65–0.9999 with every animation finished. Two animation frames render the end state.
 * Bounded like the other waits (1 s): if no frame comes, axe measures the page as it is.
 */
async function nextFrames(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 1_000);
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

/** Opens To do from the navigation (phase 15, ADR-032). */
export async function openTodo(page: Page) {
  await navLink(page, "To do").click();
  await expect(page.getByRole("heading", { name: "To do", level: 1 })).toBeVisible();
  await todoLoaded(page);
}

/** The heading renders before the data: wait for its sections, the folded one or the empty state. */
async function todoLoaded(page: Page) {
  await page
    .getByRole("main")
    .locator("section h2, details summary, .border-dashed")
    .first()
    .waitFor();
}

/**
 * A decision in To do by a text of its row (kind, product, file name). What only an admin can
 * resolve is folded under "Waiting for an administrator": it is unfolded first when present.
 */
export async function todoEntry(page: Page, text: string | RegExp) {
  await todoLoaded(page);
  const waiting = page.locator("main details");
  if ((await waiting.count()) > 0 && (await waiting.getAttribute("open")) === null) {
    await waiting.locator("summary").click();
  }
  return page.getByRole("main").getByRole("link").filter({ hasText: text }).first();
}

/**
 * A navigation link by its section name (phase 14): the pending counter of To do is part of the
 * link's accessible name ("To do 5 pending" on the sidebar, "5 pending To do" on the phone's
 * bottom bar), so an exact name no longer matches.
 */
export function navLink(page: Page, name: string) {
  return page.getByRole("link", {
    name: new RegExp(`^([0-9]+ pending )?${name}( [0-9]+ pending)?$`),
  });
}
