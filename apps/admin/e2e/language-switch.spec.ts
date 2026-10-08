import { expect, test, type Browser, type Page } from "@playwright/test";
import { E2E } from "./env";
import { login } from "./helpers";

/**
 * Language selector (phase 13, ADR-024). A person's choice is saved in their profile and follows
 * them to another browser; the shared public demo operator keeps it in the cookie only (one
 * visitor must not change the language of the others). Desktop only: the top-bar selector, and
 * it changes a saved preference (restored at the end).
 */
test.skip(({ isMobile }) => isMobile, "top-bar selector; changes a saved preference");

async function chooseLanguage(page: Page, value: "en" | "es") {
  await Promise.all([
    page.waitForEvent("load"),
    page.getByLabel(/^(Language|Idioma)$/).selectOption(value),
  ]);
}

/** A fresh browser (English Accept-Language, no cookies): what language does this user get? */
async function languageInNewBrowser(browser: Browser, who: "operator" | "admin") {
  const context = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill(E2E[who].email);
  await page.getByLabel("Password").fill(E2E[who].password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: /^(Home|Inicio)$/, level: 1 })).toBeVisible();
  const lang = await page.locator("html").getAttribute("lang");
  await context.close();
  return lang;
}

test("the admin's choice is saved and applied at the next login elsewhere", async ({
  page,
  browser,
}) => {
  await login(page, "admin");
  await chooseLanguage(page, "es");
  await expect(page.getByRole("heading", { name: "Inicio", level: 1 })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  try {
    expect(await languageInNewBrowser(browser, "admin")).toBe("es");
  } finally {
    // Restore English for the rest of the suite (and prove switching back works).
    await chooseLanguage(page, "en");
    await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
  }
  expect(await languageInNewBrowser(browser, "admin")).toBe("en");
});

test("the shared demo operator switches with a cookie only (nothing saved)", async ({
  page,
  browser,
}) => {
  await login(page, "operator");
  await chooseLanguage(page, "es");
  await expect(page.getByRole("heading", { name: "Inicio", level: 1 })).toBeVisible();
  // No error toast: the panel does not even try to save it for the shared account.
  await expect(page.getByText("No se pudo guardar tu idioma", { exact: false })).toHaveCount(0);
  expect(await languageInNewBrowser(browser, "operator")).toBe("en");
});

test("the login screen has its own selector", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await chooseLanguage(page, "es");
  await expect(page.getByRole("button", { name: "Ingresar" })).toBeVisible();
  await chooseLanguage(page, "en");
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
});
