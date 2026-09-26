import { expect, test } from "@playwright/test";
import { expectAccessible, login } from "./helpers";

test.describe("panel shell + dashboard (phase 9 M1)", () => {
  test("login lands on the dashboard with the seeded numbers", async ({ page }) => {
    await login(page);
    await expect(page.getByText("Revisiones pendientes")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Mensajes por día" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Qué se resolvió sin llamar a la IA" }),
    ).toBeVisible();
    await expect(page.getByText("Saludos y charla")).toBeVisible();
    await expectAccessible(page);
  });

  test("the period switch reloads the data", async ({ page }) => {
    await login(page);
    await page.getByRole("button", { name: "30 días" }).click();
    await expect(page.getByText("Últimos 30 días")).toBeVisible();
  });

  test("navigation: bottom bar on phones, sidebar on desktop", async ({ page, isMobile }) => {
    await login(page);
    if (isMobile) {
      await page.getByRole("button", { name: "Más" }).click();
      await expect(page.getByRole("link", { name: "Reglas" })).toBeVisible();
      await page.getByRole("link", { name: "Reglas" }).click();
    } else {
      await page.getByRole("link", { name: "Reglas" }).first().click();
    }
    await expect(page.getByRole("heading", { name: "Reglas" })).toBeVisible();
  });

  test("an operator does not see the Users section", async ({ page, isMobile }) => {
    await login(page, "operator");
    if (isMobile) await page.getByRole("button", { name: "Más" }).click();
    await expect(page.getByRole("link", { name: "Usuarios" })).toHaveCount(0);
  });
});
