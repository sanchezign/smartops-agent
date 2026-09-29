import { expect, test, type Page } from "@playwright/test";
import { expectAccessible, login } from "./helpers";

/** Rules and users (phase 9 M6). Changes run on desktop only (shared demo database). */

async function openFromMore(page: Page, name: "Reglas" | "Usuarios", isMobile: boolean) {
  if (isMobile) await page.getByRole("button", { name: "Más" }).click();
  await page.getByRole("link", { name, exact: true }).click();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
}

test.describe("rules (phase 9 M6)", () => {
  test("an operator sees the rules read-only", async ({ page, isMobile }) => {
    await login(page, "operator");
    await openFromMore(page, "Reglas", isMobile);
    await expect(page.getByText("cambiarlas es solo para administradores")).toBeVisible();
    await expect(
      page.getByRole("switch", { name: "El bot responde a los contactos" }),
    ).toBeDisabled();
    await expect(page.getByRole("button", { name: /^Guardar/ })).toHaveCount(0);
    await expectAccessible(page);
  });

  test("an operator cannot open Users (direct URL → no permission)", async ({ page }) => {
    await login(page, "operator");
    await page.goto("/usuarios");
    await expect(page.getByText("No tienes permiso para ver esto")).toBeVisible();
  });
});

test.describe("rules and users changes (desktop only)", () => {
  test.skip(({ isMobile }) => isMobile, "mutations run once, on desktop");

  test("switch the bot off (chip in the top bar) and back on; a typo is explained", async ({
    page,
  }) => {
    await login(page);
    await openFromMore(page, "Reglas", false);
    await page.getByRole("switch", { name: "El bot responde a los contactos" }).click();
    await page.getByRole("button", { name: 'Guardar "Respuestas automáticas"' }).click();
    await expect(page.getByText("Guardado.")).toBeVisible();
    await expect(page.getByText("Bot apagado")).toBeVisible();

    await page.getByRole("switch", { name: "El bot responde a los contactos" }).click();
    await page.getByRole("button", { name: 'Guardar "Respuestas automáticas"' }).click();
    await expect(page.getByText("Bot apagado")).toHaveCount(0);

    await page.getByLabel("Máximo de resúmenes por hora").fill("1.500");
    await page.getByRole("button", { name: 'Guardar "Avisos al equipo por WhatsApp"' }).click();
    await expect(page.getByRole("alert").filter({ hasText: "sin punto de miles" })).toBeVisible();
    await expectAccessible(page);
  });

  test("business hours: configure Monday to Friday", async ({ page }) => {
    await login(page);
    await openFromMore(page, "Reglas", false);
    await page.getByRole("switch", { name: "Usar horario de atención" }).click();
    for (const day of ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes"]) {
      await page.getByRole("checkbox", { name: day }).check();
    }
    await page.getByRole("button", { name: 'Guardar "Horario de atención"' }).click();
    await expect(page.getByText("Guardado.")).toBeVisible();
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Viernes: abre" })).toHaveValue("09:00");
  });

  test("users: create, promote, demote; nobody changes their own role; weak passwords explained", async ({
    page,
  }) => {
    await login(page);
    await openFromMore(page, "Usuarios", false);
    const list = page.getByRole("list", { name: "Usuarios" });
    await list.getByRole("button", { name: /Acciones para Admin demo/ }).click();
    await expect(
      page.getByRole("menuitem", { name: "Tu rol lo cambia otro administrador" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Nuevo usuario" }).click();
    await page.getByLabel("Nombre").fill("Carla Depósito");
    await page.getByLabel("Email").fill("carla@ferreteria.demo");
    await page.getByLabel("Contraseña").fill("corta");
    await page.getByRole("button", { name: "Crear" }).click();
    await expect(page.getByText(/Mínimo 15 caracteres/).first()).toBeVisible();
    await page.getByLabel("Contraseña").fill("la escalera del galpón tiene cinco peldaños");
    await page.getByRole("button", { name: "Crear" }).click();
    await expect(page.getByText("Usuario creado.")).toBeVisible();

    await list.getByRole("button", { name: /Acciones para Carla Depósito/ }).click();
    await page.getByRole("menuitem", { name: "Cambiar a administrador" }).click();
    await expect(page.getByText("Usuario actualizado.")).toBeVisible();
    await expect(
      list.getByRole("listitem").filter({ hasText: "Carla Depósito" }).getByText("Administrador"),
    ).toBeVisible();
    await list.getByRole("button", { name: /Acciones para Carla Depósito/ }).click();
    await page.getByRole("menuitem", { name: "Desactivar" }).click();
    await expect(
      list.getByRole("listitem").filter({ hasText: "Carla Depósito" }).getByText("Desactivado"),
    ).toBeVisible();
    await expectAccessible(page);
  });
});
