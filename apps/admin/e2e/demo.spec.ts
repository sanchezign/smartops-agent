import { expect, test, type Page } from "@playwright/test";
import { E2E } from "./env";
import { expectAccessible } from "./helpers";

/**
 * Public demo (DEMO_MODE, phase 9 M8). The E2E API runs in demo mode with the real worker and
 * a stand-in for n8n (apps/api/scripts/demo/e2e-n8n.ts), so every button goes through the
 * real pipeline: signed webhook → worker → demo Graph API → transcription / conversion →
 * classify → extract (recorded outputs) → catalog / reviews.
 */

async function loginWithDemoCard(page: Page) {
  await page.goto("/login");
  const card = page.getByText("Demo pública.").locator("..").locator("..");
  await expect(card.getByText(E2E.operator.email)).toBeVisible();
  await expect(card.getByText(E2E.operator.password)).toBeVisible();
  await page.getByRole("button", { name: "Usar estos datos" }).click();
  await page.getByRole("button", { name: "Ingresar" }).click();
  await expect(page.getByRole("heading", { name: "Inicio" })).toBeVisible();
}

test.describe("public demo (phase 9 M8)", () => {
  test("login shows the public operator credentials; the panel shows the demo banner", async ({
    page,
  }) => {
    await loginWithDemoCard(page);
    await expect(page.getByText("Modo demo")).toBeVisible();
    await page.getByRole("link", { name: "Probar el sistema" }).first().click();
    await expect(page.getByRole("heading", { name: "Probar el sistema", level: 1 })).toBeVisible();
    await expectAccessible(page);
  });
});

test.describe("every sample goes through the real pipeline (desktop: shared demo data)", () => {
  test.skip(({ isMobile }) => isMobile, "runs once, on desktop");
  test.setTimeout(240_000);

  const cases: [string, RegExp][] = [
    ["Enviar foto de lista de precios", /Catálogo al día|líneas? para revisar/],
    ["Enviar PDF de proveedor", /Procesado: no hubo cambios|Catálogo al día/],
    ["Enviar audio de proveedor", /para revisar|Quedó en Revisiones|Catálogo al día/],
    ["Enviar planilla conocida", /Catálogo al día/],
    ["Enviar planilla nueva", /formato nuevo/],
    ["Enviar mensaje con prompt injection", /órdenes al sistema/],
  ];

  test("photo, PDF, voice note, known and new spreadsheet, prompt injection", async ({ page }) => {
    await loginWithDemoCard(page);
    await page.goto("/probar");
    for (const [button, outcome] of cases) {
      await page.getByRole("button", { name: button }).click();
      const card = page
        .getByRole("region", { name: "Mensajes de prueba enviados" })
        .getByRole("status")
        .first();
      await expect(card).toHaveText(outcome, { timeout: 60_000 });
    }
    // The new spreadsheet waits for a person in Revisiones (column picker).
    await page.getByRole("link", { name: "Revisiones", exact: true }).click();
    await expect(
      page.getByRole("list", { name: "Revisiones" }).getByText("Precios Mayorista del Este.xlsx"),
    ).toBeVisible();
  });

  test("Reiniciar demo brings the sample data back and keeps the session", async ({ page }) => {
    await loginWithDemoCard(page);
    // Open screens before the reset: a chat (stable id) and a review (recreated → new id).
    await page.goto("/conversaciones");
    await page.getByLabel("Buscar por nombre, proveedor o teléfono").fill("Luis");
    await page
      .getByRole("list", { name: "Conversaciones" })
      .getByRole("link", { name: /Luis Fernández/ })
      .click();
    await expect(page.getByRole("heading", { name: "Luis Fernández" })).toBeVisible();
    const chatUrl = page.url();
    await page.goto("/revisiones");
    await page.getByRole("list", { name: "Revisiones" }).getByText("Aumento general").click();
    await expect(page.getByRole("heading", { name: "Aumento general" })).toBeVisible();
    const reviewUrl = page.url();
    await page.goto("/probar");
    await page.getByRole("button", { name: "Reiniciar demo" }).click();
    await page.getByRole("button", { name: "Reiniciar", exact: true }).click();
    await expect(page.getByText("Demo reiniciada")).toBeVisible({ timeout: 60_000 });
    await page.getByRole("link", { name: "Revisiones", exact: true }).click();
    const list = page.getByRole("list", { name: "Revisiones" });
    await expect(list.getByText("Lista Distribuidora Norte.xlsx")).toBeVisible();
    await expect(list.getByText("Precios Mayorista del Este.xlsx")).toHaveCount(0);

    // The chat link survives the reset; the old review says it no longer exists.
    await page.goto(chatUrl);
    await expect(page.getByRole("heading", { name: "Luis Fernández" })).toBeVisible();
    await page.goto(reviewUrl);
    await expect(
      page.getByText("Esto ya no existe (la demo se pudo haber reiniciado)"),
    ).toBeVisible();
    await page.getByRole("link", { name: "Volver a Revisiones" }).click();
    await expect(page.getByRole("heading", { name: "Revisiones", level: 1 })).toBeVisible();
  });
});
