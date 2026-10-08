import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
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
 * WCAG 2.1 A/AA checks (axe) on the current page. Toasts are measured only once their entry
 * transition has finished: mid-fade, axe blends the text with what is behind and reports a
 * contrast that no user ever sees for more than 0.4 s (phase 11, CI). The config also emulates
 * reduced motion (sonner then skips the transitions); this wait covers any other motion.
 */
export async function expectAccessible(page: Page) {
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll("[data-sonner-toast]")).every((el) =>
        el.getAnimations({ subtree: true }).every((a) => a.playState !== "running"),
      ),
    undefined,
    { timeout: 5_000 },
  );
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    results.violations.map(
      (v) => `${v.id}: ${v.help} → ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
    ),
  ).toEqual([]);
}

/**
 * A navigation link by its section name (phase 14): the pending counter of Reviews / Alerts is
 * part of the link's accessible name ("Reviews 14 pending" on the sidebar, "14 pending Reviews"
 * on the phone's bottom bar), so an exact name no longer matches.
 */
export function navLink(page: Page, name: string) {
  return page.getByRole("link", {
    name: new RegExp(`^([0-9]+ pending )?${name}( [0-9]+ pending)?$`),
  });
}
