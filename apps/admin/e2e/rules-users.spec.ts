import { expect, test, type Page } from "@playwright/test";
import { expectAccessible, login, navLink } from "./helpers";

/** Rules and users (phase 9 M6). Changes run on desktop only (shared demo database). */

async function openFromMore(page: Page, name: "Rules" | "Users", isMobile: boolean) {
  if (isMobile) await page.getByRole("button", { name: "More" }).click();
  await navLink(page, name).click();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
}

test.describe("rules (phase 9 M6)", () => {
  test("an operator sees the rules read-only", async ({ page, isMobile }) => {
    await login(page, "operator");
    await openFromMore(page, "Rules", isMobile);
    await expect(page.getByText("changing them is for administrators only")).toBeVisible();
    await expect(page.getByRole("switch", { name: "The bot replies to contacts" })).toBeDisabled();
    await expect(page.getByRole("button", { name: /^Save/ })).toHaveCount(0);
    await expectAccessible(page);
  });

  test("an operator cannot open Users (direct URL → no permission)", async ({ page }) => {
    await login(page, "operator");
    await page.goto("/users");
    await expect(page.getByText("You don't have permission to see this")).toBeVisible();
  });
});

test.describe("rules and users changes (desktop only)", () => {
  test.skip(({ isMobile }) => isMobile, "mutations run once, on desktop");

  test("switch the bot off (chip in the top bar) and back on; a typo is explained", async ({
    page,
  }) => {
    await login(page);
    await openFromMore(page, "Rules", false);
    await page.getByRole("switch", { name: "The bot replies to contacts" }).click();
    await page.getByRole("button", { name: 'Save "Automatic replies"' }).click();
    await expect(page.getByText("Saved.")).toBeVisible();
    await expect(page.getByText("Bot off")).toBeVisible();

    await page.getByRole("switch", { name: "The bot replies to contacts" }).click();
    await page.getByRole("button", { name: 'Save "Automatic replies"' }).click();
    await expect(page.getByText("Bot off")).toHaveCount(0);

    await page.getByLabel("Maximum summaries per hour").fill("1,500"); // ambiguous in English
    await page.getByRole("button", { name: 'Save "WhatsApp alerts to the team"' }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "without a thousands separator" }),
    ).toBeVisible();
    await expectAccessible(page);
  });

  test("business hours: configure Monday to Friday", async ({ page }) => {
    await login(page);
    await openFromMore(page, "Rules", false);
    await page.getByRole("switch", { name: "Use business hours" }).click();
    for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]) {
      await page.getByRole("checkbox", { name: day }).check();
    }
    await page.getByRole("button", { name: 'Save "Business hours"' }).click();
    await expect(page.getByText("Saved.")).toBeVisible();
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Friday: opens" })).toHaveValue("09:00");
  });

  test("users: create, promote, demote; nobody changes their own role; weak passwords explained", async ({
    page,
  }) => {
    await login(page);
    await openFromMore(page, "Users", false);
    const list = page.getByRole("list", { name: "Users" });
    await list.getByRole("button", { name: /Actions for Admin demo/ }).click();
    await expect(
      page.getByRole("menuitem", { name: "Another administrator changes your role" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "New user" }).click();
    await page.getByLabel("Name").fill("Carla Depósito");
    await page.getByLabel("Email").fill("carla@ferreteria.demo");
    await page.getByLabel("Password").fill("corta");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByText(/At least 15 characters/).first()).toBeVisible();
    await page.getByLabel("Password").fill("la escalera del galpón tiene cinco peldaños");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByText("User created.")).toBeVisible();

    await list.getByRole("button", { name: /Actions for Carla Depósito/ }).click();
    await page.getByRole("menuitem", { name: "Change to administrator" }).click();
    await expect(page.getByText("User updated.")).toBeVisible();
    await expect(
      list.getByRole("listitem").filter({ hasText: "Carla Depósito" }).getByText("Administrator"),
    ).toBeVisible();
    await list.getByRole("button", { name: /Actions for Carla Depósito/ }).click();
    await page.getByRole("menuitem", { name: "Deactivate" }).click();
    await expect(
      list.getByRole("listitem").filter({ hasText: "Carla Depósito" }).getByText("Deactivated"),
    ).toBeVisible();
    await expectAccessible(page);
  });
});
