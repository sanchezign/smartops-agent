import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { E2E } from "./env";

export async function login(page: Page, who: "operator" | "admin" = "admin") {
  const creds = E2E[who];
  await page.goto("/login");
  await page.getByLabel("Email").fill(creds.email);
  await page.getByLabel("Contraseña").fill(creds.password);
  await page.getByRole("button", { name: "Ingresar" }).click();
  await expect(page.getByRole("heading", { name: "Inicio" })).toBeVisible();
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
