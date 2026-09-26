import { expect, test, type Page } from "@playwright/test";
import { expectAccessible, login } from "./helpers";

/**
 * Conversations (phase 9 M3) on the seeded demo. Projects run one after another on the SAME
 * database: changes (pause, reply, opt-out) run on desktop only, on chats the phones never
 * check.
 */

async function openConversations(page: Page) {
  await page.getByRole("link", { name: "Conversaciones", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Conversaciones", level: 1 })).toBeVisible();
}

const inbox = (page: Page) => page.getByRole("list", { name: "Conversaciones" });

test.describe("conversations (phase 9 M3)", () => {
  test("inbox: who answers each chat, filters and search", async ({ page }) => {
    await login(page, "operator");
    await openConversations(page);
    const luis = inbox(page).getByRole("link", { name: /Luis Fernández/ });
    await expect(luis.getByText("Atiende una persona")).toBeVisible();
    await expect(
      inbox(page)
        .getByRole("link", { name: /Jorge Rodríguez/ })
        .getByText("Dado de baja"),
    ).toBeVisible();
    await expectAccessible(page);

    await page.getByRole("button", { name: "Dados de baja" }).click();
    // (desktop may have opted out another contact before: check who is in, and who is not)
    await expect(inbox(page).getByRole("link", { name: /Jorge Rodríguez/ })).toBeVisible();
    await expect(inbox(page).getByRole("link", { name: /Luis Fernández/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Todas" }).click();
    await page.getByLabel("Buscar por nombre, proveedor o teléfono").fill("pinturas");
    await expect(inbox(page).getByRole("link")).toHaveCount(1);
    await expect(inbox(page).getByText("Pinturas del Sur").first()).toBeVisible();
  });

  test("chat: the photo is loaded with the session (blob: URL, no token in the URL)", async ({
    page,
  }) => {
    const mediaRequests: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/admin/media/")) mediaRequests.push(r.url());
    });
    await login(page, "operator");
    await openConversations(page);
    await page.getByLabel("Buscar por nombre, proveedor o teléfono").fill("Norte");
    await inbox(page)
      .getByRole("link", { name: /Ventas Distribuidora Norte/ })
      .click();
    await expect(page.getByRole("heading", { name: "Ventas Distribuidora Norte" })).toBeVisible();
    // The photo is 5 days back: load older pages until its caption shows up.
    const caption = page.getByText("Foto de la lista impresa");
    for (let i = 0; i < 10 && !(await caption.isVisible()); i += 1) {
      await page.getByRole("button", { name: "Ver mensajes anteriores" }).click();
      await expect(page.getByRole("button", { name: /Cargando/ })).toHaveCount(0);
    }
    await caption.scrollIntoViewIfNeeded();
    const photo = page.getByRole("img", { name: "Foto enviada por WhatsApp" });
    await photo.scrollIntoViewIfNeeded();
    await expect(photo).toHaveAttribute("src", /^blob:/);
    await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(360);
    expect(mediaRequests.length).toBeGreaterThan(0);
    for (const url of mediaRequests) expect(url).not.toMatch(/token|sig|access/i);
    await expectAccessible(page);
  });

  test("opted-out list shows how each contact asked", async ({ page }) => {
    await login(page, "operator");
    await openConversations(page);
    await page.getByRole("link", { name: "Dados de baja" }).click();
    const list = page.getByRole("list", { name: "Contactos dados de baja" });
    await expect(list.getByText("Jorge Rodríguez")).toBeVisible();
    await expect(list.getByText(/Escribió "BAJA"/)).toBeVisible();
    await expectAccessible(page);
  });
});

test.describe("acting on conversations (desktop only: it changes the shared demo data)", () => {
  test.skip(({ isMobile }) => isMobile, "mutations run once, on desktop");

  test("spreadsheet from the chat downloads with its name", async ({ page }) => {
    await login(page);
    await openConversations(page);
    await page.getByLabel("Buscar por nombre, proveedor o teléfono").fill("Norte");
    await inbox(page)
      .getByRole("link", { name: /Ventas Distribuidora Norte/ })
      .click();
    const row = page.getByText("Lista Distribuidora Norte.xlsx").locator("..");
    const download = page.waitForEvent("download");
    await row.getByRole("button", { name: "Descargar" }).click();
    expect((await download).suggestedFilename()).toBe("Lista Distribuidora Norte.xlsx");
  });

  test("pause and resume the bot", async ({ page }) => {
    await login(page, "operator");
    await openConversations(page);
    await page.getByLabel("Buscar por nombre, proveedor o teléfono").fill("Oriental");
    await inbox(page)
      .getByRole("link", { name: /Eléctrica Oriental/ })
      .click();
    await page.getByRole("button", { name: "Pausar el bot" }).click();
    await page.getByRole("radio", { name: "30 minutos" }).click();
    await page.getByRole("button", { name: "Pausar", exact: true }).click();
    await expect(page.getByText("Atiende una persona")).toBeVisible();
    await page.getByRole("button", { name: "Reactivar el bot" }).click();
    await expect(page.getByText("Responde el bot")).toBeVisible();
  });

  test("reply as a person inside the 24 h window", async ({ page }) => {
    await login(page, "operator");
    await openConversations(page);
    await inbox(page)
      .getByRole("link", { name: /Luis Fernández/ })
      .click();
    await page.getByLabel("Tu respuesta").fill("Sí, tenemos 4 en stock. ¿Te reservo uno?");
    await page.getByRole("button", { name: "Enviar" }).click();
    await expect(page.getByText("Enviado. El bot queda en pausa")).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Mensajes" }).getByText("Sí, tenemos 4 en stock."),
    ).toBeVisible();
  });

  test("an operator records an opt-out; opting back in is admin-only", async ({ page }) => {
    await login(page, "operator");
    await openConversations(page);
    await inbox(page)
      .getByRole("link", { name: /Marta Silva/ })
      .click();
    await page.getByRole("button", { name: "Más acciones" }).click();
    await page.getByRole("menuitem", { name: /Registrar baja/ }).click();
    await page.getByLabel("Motivo (obligatorio)").fill("Llamó y pidió que no le escribamos");
    await page.getByRole("button", { name: "Confirmar" }).click();
    await expect(page.getByText("Baja registrada")).toBeVisible();
    await expect(page.getByText("Dado de baja").first()).toBeVisible();
    await page.getByRole("button", { name: "Más acciones" }).click();
    await expect(page.getByRole("menuitem", { name: /solo para administradores/ })).toBeVisible();
  });
});
