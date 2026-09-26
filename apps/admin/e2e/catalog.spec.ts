import { expect, test, type Page } from "@playwright/test";
import { expectAccessible, login } from "./helpers";

/** Catalog, price history and alerts (phase 9 M5) on the seeded demo. */

async function goTo(page: Page, name: "Catálogo" | "Alertas", isMobile: boolean) {
  if (name === "Alertas" && isMobile) await page.getByRole("button", { name: "Más" }).click();
  await page.getByRole("link", { name, exact: true }).click();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
}

test.describe("catalog (phase 9 M5)", () => {
  test("products per supplier with price, change and a price history chart", async ({
    page,
    isMobile,
  }) => {
    await login(page, "operator");
    await goTo(page, "Catálogo", isMobile);
    await page.getByRole("combobox", { name: "Proveedor" }).click();
    await page.getByRole("option", { name: /Distribuidora Norte/ }).click();
    await page.getByLabel("Buscar producto").fill("tornillo 6");
    const list = page.getByRole("list", { name: "Productos" });
    await expect(list.getByRole("link")).toHaveCount(1);
    await expect(list.getByText(/\$\s?\d/)).toBeVisible(); // "$ 1.234,50" style money
    await expect(page.getByRole("button", { name: "Renombrar" })).toHaveCount(0); // operator
    await expectAccessible(page);

    await list.getByRole("link").click();
    await expect(page.getByRole("heading", { name: "Tornillo 6mm", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Historial de precios" })).toBeVisible();
    const changes = page.getByRole("list", { name: "Cambios de precio" });
    await expect(changes.getByRole("listitem").first()).toBeVisible();
    expect(await changes.getByRole("listitem").count()).toBeGreaterThan(2);
    await expect(page.locator(".recharts-line-curve")).toBeVisible();
    await expectAccessible(page);
  });

  test("alerts: open ones with links to the product", async ({ page, isMobile }) => {
    await login(page, "operator");
    await goTo(page, "Alertas", isMobile);
    const list = page.getByRole("list", { name: "Alertas" });
    await expect(list.getByText("Cambio de precio").first()).toBeVisible();
    await expect(list.getByRole("link", { name: "Ver producto" }).first()).toBeVisible();
    await expectAccessible(page);
  });
});

test.describe("catalog changes (desktop only: shared demo data)", () => {
  test.skip(({ isMobile }) => isMobile, "mutations run once, on desktop");

  test("an admin renames a supplier", async ({ page }) => {
    await login(page);
    await goTo(page, "Catálogo", false);
    await page.getByRole("combobox", { name: "Proveedor" }).click();
    await page.getByRole("option", { name: /Pinturas del Sur/ }).click();
    await page.getByRole("button", { name: "Renombrar" }).click();
    await page.getByLabel("Nombre").fill("Pinturas del Sur S.R.L.");
    await page.getByRole("button", { name: "Guardar" }).click();
    await expect(page.getByText("Proveedor renombrado.")).toBeVisible();
    await page.getByRole("combobox", { name: "Proveedor" }).click();
    await expect(page.getByRole("option", { name: /Pinturas del Sur S\.R\.L\./ })).toBeVisible();
  });

  test("acknowledge an alert", async ({ page }) => {
    await login(page, "operator");
    await goTo(page, "Alertas", false);
    const first = page.getByRole("list", { name: "Alertas" }).getByRole("listitem").first();
    const title = (await first.locator("p").first().textContent())!;
    await first.getByRole("button", { name: /Marcar como vista/ }).click();
    await expect(
      page.getByRole("list", { name: "Alertas" }).getByText(title, { exact: true }),
    ).toHaveCount(0);
  });
});
