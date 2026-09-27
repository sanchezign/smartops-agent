import { expect, test, type Page } from "@playwright/test";
import { expectAccessible, login } from "./helpers";

/**
 * Review queue (phase 9 M2) on the seeded demo. Projects run one after the other on the SAME
 * database, so tests that resolve a review run only on desktop; phones check reading and the
 * role rules on items nobody resolves.
 */

async function openReviews(page: Page, isMobile: boolean) {
  void isMobile; // sidebar on desktop, bottom bar on phones: the hidden one is not a link to click
  await page.getByRole("link", { name: "Revisiones", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Revisiones", level: 1 })).toBeVisible();
}

test.describe("review queue (phase 9 M2)", () => {
  test("lists every pending kind with counts per scope", async ({ page, isMobile }) => {
    await login(page);
    await openReviews(page, isMobile);
    const list = page.getByRole("list", { name: "Revisiones" });
    await expect(list.getByText("Aumento general")).toBeVisible();
    await expect(list.getByText("Mensaje sospechoso")).toBeVisible();
    await expect(list.getByText("¿Marcar como no disponible?")).toBeVisible();
    await page.getByRole("button", { name: /^Catálogo/ }).click();
    await expect(list.getByText("Mensaje sospechoso")).toHaveCount(0);
    await expect(list.getByText("Aumento general")).toBeVisible();
    await expectAccessible(page);
  });

  test("a whole-list review is read-only for an operator", async ({ page, isMobile }) => {
    await login(page, "operator");
    await openReviews(page, isMobile);
    await page.getByRole("list", { name: "Revisiones" }).getByText("Mensaje sospechoso").click();
    await expect(page.getByRole("heading", { name: "Mensaje sospechoso" })).toBeVisible();
    // Where the buttons would be (pinned at the bottom on phones): no hunting for buttons.
    const notice = page.getByText("Solo un administrador puede resolver esta revisión.");
    await expect(notice).toBeVisible();
    if (isMobile) await expect(notice).toBeInViewport();
    await expect(page.getByRole("button", { name: "Procesar igual" })).toHaveCount(0);
    await expectAccessible(page);
  });

  test("the global change shows every product before and after", async ({ page, isMobile }) => {
    await login(page);
    await openReviews(page, isMobile);
    await page.getByRole("list", { name: "Revisiones" }).getByText("Aumento general").click();
    await expect(page.getByRole("columnheader", { name: "Después" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Aplicar \+8 %/ })).toBeVisible();
    await expectAccessible(page);
  });
});

test.describe("resolving reviews (desktop only: it changes the shared demo data)", () => {
  test.skip(({ isMobile }) => isMobile, "mutations run once, on desktop");

  test("spreadsheet: pick the price column with real values, approve → back to extraction", async ({
    page,
  }) => {
    await login(page);
    await openReviews(page, false);
    await page
      .getByRole("list", { name: "Revisiones" })
      .getByText("Lista Distribuidora Norte.xlsx")
      .click();
    await expect(page.getByRole("heading", { name: "Elegí la columna de precio" })).toBeVisible();
    const group = page.getByRole("radiogroup", { name: /Columna de precio/ });
    const withTax = group.getByRole("radio", { name: /Precio c\/IVA/ });
    await expect(withTax).toBeChecked(); // the recommendation is pre-selected…
    await expect(group.getByText("Sugerida")).toBeVisible();
    await expect(group.getByText("320").first()).toBeVisible(); // …next to values from the file
    await expectAccessible(page);
    await group.getByRole("radio", { name: /Mayorista/ }).click();
    await page.getByRole("button", { name: "Usar esta columna" }).click();
    await expect(page.getByText("La lista se vuelve a procesar")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Revisiones", level: 1 })).toBeVisible();
    await expect(
      page.getByRole("list", { name: "Revisiones" }).getByText("Lista Distribuidora Norte.xlsx"),
    ).toHaveCount(0);
  });

  test("line: correct the price and apply it (operator)", async ({ page }) => {
    await login(page, "operator");
    await openReviews(page, false);
    await page.getByRole("button", { name: /^Productos/ }).click();
    await page.getByRole("list", { name: "Revisiones" }).getByText("Arena gruesa").click();
    await expect(page.getByRole("heading", { name: /fuera de lo normal/ })).toBeVisible();
    await page.getByLabel("Precio", { exact: true }).fill("1.900");
    await page.getByRole("button", { name: "Aplicar precio" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "punto de miles" })).toBeVisible();
    await page.getByLabel("Precio", { exact: true }).fill("1900");
    await page.getByRole("button", { name: "Aplicar precio" }).click();
    await expect(page.getByText("Aprobada y aplicada.")).toBeVisible();
  });

  test("reject with a note", async ({ page }) => {
    await login(page);
    await openReviews(page, false);
    await page
      .getByRole("list", { name: "Revisiones" })
      .getByText("Pintura látex blanca 4L")
      .click();
    await page.getByRole("button", { name: "Rechazar" }).click();
    await page.getByLabel("Nota").fill("No se entiende el audio: le pido que lo escriba");
    await page.getByRole("button", { name: "Confirmar" }).click();
    await expect(page.getByText("Revisión rechazada")).toBeVisible();
    await page.getByRole("button", { name: "Rechazadas" }).click();
    await expect(
      page.getByRole("list", { name: "Revisiones" }).getByText("Pintura látex blanca 4L"),
    ).toBeVisible();
  });
});
