import { expect, test, type Page } from "@playwright/test";
import { expectAccessible, login, navLink } from "./helpers";

/**
 * Conversations (phase 9 M3) on the seeded demo. Projects run one after another on the SAME
 * database: changes (pause, reply, opt-out) run on desktop only, on chats the phones never
 * check.
 */

async function openConversations(page: Page) {
  await navLink(page, "Conversations").click();
  await expect(page.getByRole("heading", { name: "Conversations", level: 1 })).toBeVisible();
}

const inbox = (page: Page) => page.getByRole("list", { name: "Conversations" });

test.describe("conversations (phase 9 M3)", () => {
  test("inbox: who answers each chat, filters and search", async ({ page }) => {
    await login(page, "operator");
    await openConversations(page);
    const luis = inbox(page).getByRole("link", { name: /Luis Fernández/ });
    await expect(luis.getByText("A person is handling it")).toBeVisible();
    await expect(
      inbox(page)
        .getByRole("link", { name: /Jorge Rodríguez/ })
        .getByText("Opted out"),
    ).toBeVisible();
    await expectAccessible(page);

    await page.getByRole("button", { name: "Opted out" }).click();
    // (desktop may have opted out another contact before: check who is in, and who is not)
    await expect(inbox(page).getByRole("link", { name: /Jorge Rodríguez/ })).toBeVisible();
    await expect(inbox(page).getByRole("link", { name: /Luis Fernández/ })).toHaveCount(0);
    await page.getByRole("button", { name: "All" }).click();
    await page.getByLabel("Search by name, supplier or phone").fill("pinturas");
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
    await page.getByLabel("Search by name, supplier or phone").fill("Norte");
    await inbox(page)
      .getByRole("link", { name: /Ventas Distribuidora Norte/ })
      .click();
    await expect(page.getByRole("heading", { name: "Ventas Distribuidora Norte" })).toBeVisible();
    // The photo is 5 days back: load older pages until its caption shows up.
    const caption = page.getByText("Foto de la lista impresa");
    for (let i = 0; i < 10 && !(await caption.isVisible()); i += 1) {
      await page.getByRole("button", { name: "Show earlier messages" }).click();
      await expect(page.getByRole("button", { name: /Loading/ })).toHaveCount(0);
    }
    await caption.scrollIntoViewIfNeeded();
    const photo = page.getByRole("img", { name: "Photo sent over WhatsApp" });
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
    await page.getByRole("link", { name: "Opted out", exact: true }).click();
    const list = page.getByRole("list", { name: "Opted-out contacts" });
    await expect(list.getByText("Jorge Rodríguez")).toBeVisible();
    await expect(list.getByText(/Wrote "BAJA"/)).toBeVisible();
    await expectAccessible(page);
  });
});

test.describe("acting on conversations (desktop only: it changes the shared demo data)", () => {
  test.skip(({ isMobile }) => isMobile, "mutations run once, on desktop");

  test("spreadsheet from the chat downloads with its name", async ({ page }) => {
    await login(page);
    await openConversations(page);
    await page.getByLabel("Search by name, supplier or phone").fill("Norte");
    await inbox(page)
      .getByRole("link", { name: /Ventas Distribuidora Norte/ })
      .click();
    const row = page.getByText("Lista Distribuidora Norte.xlsx").locator("..");
    const download = page.waitForEvent("download");
    await row.getByRole("button", { name: "Download" }).click();
    expect((await download).suggestedFilename()).toBe("Lista Distribuidora Norte.xlsx");
  });

  test("pause and resume the bot", async ({ page }) => {
    await login(page, "operator");
    await openConversations(page);
    await page.getByLabel("Search by name, supplier or phone").fill("Oriental");
    await inbox(page)
      .getByRole("link", { name: /Eléctrica Oriental/ })
      .click();
    await page.getByRole("button", { name: "Pause the bot" }).click();
    await page.getByRole("radio", { name: "30 minutes" }).click();
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(page.getByText("A person is handling it")).toBeVisible();
    await page.getByRole("button", { name: "Reactivate the bot" }).click();
    // (.first(): the badge; the toast "The bot answers again." comes later in the page)
    await expect(page.getByText("The bot answers").first()).toBeVisible();
  });

  test("reply as a person inside the 24 h window", async ({ page }) => {
    await login(page, "operator");
    await openConversations(page);
    await inbox(page)
      .getByRole("link", { name: /Luis Fernández/ })
      .click();
    await page.getByLabel("Your reply").fill("Sí, tenemos 4 en stock. ¿Te reservo uno?");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Sent. The bot stays paused")).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Messages" }).getByText("Sí, tenemos 4 en stock."),
    ).toBeVisible();
  });

  test("an operator records an opt-out; opting back in is admin-only", async ({ page }) => {
    await login(page, "operator");
    await openConversations(page);
    await inbox(page)
      .getByRole("link", { name: /Marta Silva/ })
      .click();
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: /Record opt-out/ }).click();
    await page.getByLabel("Reason (required)").fill("Llamó y pidió que no le escribamos");
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByText("Opt-out recorded")).toBeVisible();
    await expect(page.getByText("Opted out").first()).toBeVisible();
    await page.getByRole("button", { name: "More actions" }).click();
    await expect(page.getByRole("menuitem", { name: /for administrators only/ })).toBeVisible();
  });
});
