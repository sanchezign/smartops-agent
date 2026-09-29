import { expect, test, type Page } from "@playwright/test";
import { E2E } from "./env";
import { expectAccessible } from "./helpers";

/**
 * Spanish smoke + accessibility (phase 13 M4). The whole suite runs in English; this file runs a
 * Spanish browser (Accept-Language es-UY) through every main screen: the panel must come up in
 * neutral Spanish with es-UY numbers, and pass axe in Spanish too.
 */
test.use({ locale: "es-UY" });

async function loginEs(page: Page, who: "operator" | "admin") {
  await page.goto("/login");
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await page.getByLabel("Email").fill(E2E[who].email);
  await page.getByLabel("Contraseña").fill(E2E[who].password);
  await page.getByRole("button", { name: "Ingresar" }).click();
  await expect(page.getByRole("heading", { name: "Inicio", level: 1 })).toBeVisible();
}

test("a Spanish browser sees the login and the panel in Spanish (axe in Spanish)", async ({
  page,
}) => {
  await page.goto("/login");
  await expect(page.getByText("Demo pública.")).toBeVisible();
  await expectAccessible(page);

  await loginEs(page, "operator");
  await expect(page.getByText("Revisiones pendientes")).toBeVisible();
  await expect(page.getByText("Saludos y charla")).toBeVisible();
  await expectAccessible(page);
});

test("main screens in Spanish, es-UY money, and accessible", async ({ page, isMobile }) => {
  await loginEs(page, "operator");
  const open = async (path: string, heading: string) => {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading, level: 1 })).toBeVisible();
    await expectAccessible(page);
  };
  await open("/revisiones", "Revisiones");
  await expect(
    page.getByRole("list", { name: "Revisiones" }).getByText("Aumento general"),
  ).toBeVisible();

  await open("/catalogo", "Catálogo");
  await page.getByLabel("Buscar producto").fill("tornillo 6");
  // es-UY money: "$ 1.234,50" (a space after "$", comma decimals).
  await expect(
    page
      .getByRole("list", { name: "Productos" })
      .getByText(/\$\s\d{1,3}(\.\d{3})*,\d{2}/)
      .first(),
  ).toBeVisible();

  await open("/conversaciones", "Conversaciones");
  await expect(page.getByText("Atiende una persona").first()).toBeVisible();

  await open("/alertas", "Alertas");
  await open("/reglas", "Reglas");
  await expect(page.getByText("cambiarlas es solo para administradores")).toBeVisible();

  if (!isMobile) {
    await expect(page.getByLabel("Idioma", { exact: true })).toHaveValue("es");
  }
});
