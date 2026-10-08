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
    const luis = inbox(page).getByRole("link", { name: /Louis Fernandez/ });
    await expect(luis.getByText("A person is handling it")).toBeVisible();
    await expect(
      inbox(page)
        .getByRole("link", { name: /George Rodgers/ })
        .getByText("Opted out"),
    ).toBeVisible();
    await expectAccessible(page);

    await page.getByRole("button", { name: "Opted out" }).click();
    // (desktop may have opted out another contact before: check who is in, and who is not)
    await expect(inbox(page).getByRole("link", { name: /George Rodgers/ })).toBeVisible();
    await expect(inbox(page).getByRole("link", { name: /Louis Fernandez/ })).toHaveCount(0);
    await page.getByRole("button", { name: "All" }).click();
    await page.getByLabel("Search by name, supplier or phone").fill("tessaly");
    await expect(inbox(page).getByRole("link")).toHaveCount(1);
    await expect(inbox(page).getByText("Tessaly Paint & Coatings").first()).toBeVisible();
  });

  test("chat: who answers and the main action stay in view as it opens (phase 14 #8)", async ({
    page,
  }) => {
    await login(page, "operator");
    await openConversations(page);
    await inbox(page)
      .getByRole("link", { name: /Louis Fernandez/ })
      .click();
    // A chat opens at its newest message: the header must still be on screen, and compact.
    const bar = page
      .locator("header")
      .filter({ has: page.getByRole("heading", { level: 1, name: /Louis/ }) });
    await expect(page.getByRole("heading", { level: 1, name: /Louis/ })).toBeInViewport({
      ratio: 1,
    });
    await expect(bar.getByText("A person is handling it")).toBeInViewport({ ratio: 1 });
    await expect(bar.getByRole("button", { name: /Reactivate the bot/ })).toBeInViewport({
      ratio: 1,
    });
    // …and it stays there while the chat scrolls.
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(bar.getByRole("button", { name: /Reactivate the bot/ })).toBeInViewport({
      ratio: 1,
    });
    expect((await bar.boundingBox())!.height).toBeLessThan(150);
    // A long name wraps to at most two lines instead of being cut (phase 14, owner's request).
    const title = page.getByRole("heading", { level: 1, name: /Louis/ });
    await title.evaluate((el) => {
      el.textContent =
        "Louis Fernandez de la Cruz and Ordonez of Columbus Eastern Wholesale Supplies";
    });
    const box = (await title.boundingBox())!;
    const lineHeight = await title.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
    expect(box.height).toBeLessThanOrEqual(lineHeight * 2 + 2);
    expect(box.height).toBeGreaterThan(lineHeight * 1.5); // …and it does use the second line
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
    await page.getByLabel("Search by name, supplier or phone").fill("Corvane");
    await inbox(page)
      .getByRole("link", { name: /Corvane Sales Desk/ })
      .click();
    await expect(page.getByRole("heading", { name: "Corvane Sales Desk" })).toBeVisible();
    // The photo is 5 days back: load older pages until its caption shows up.
    const caption = page.getByText("Photo of the printed list");
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
    await expect(list.getByText("George Rodgers")).toBeVisible();
    await expect(list.getByText(/Wrote "STOP"/)).toBeVisible();
    await expectAccessible(page);
  });
});

test.describe("acting on conversations (desktop only: it changes the shared demo data)", () => {
  test.skip(({ isMobile }) => isMobile, "mutations run once, on desktop");

  test("spreadsheet from the chat downloads with its name", async ({ page }) => {
    await login(page);
    await openConversations(page);
    await page.getByLabel("Search by name, supplier or phone").fill("Corvane");
    await inbox(page)
      .getByRole("link", { name: /Corvane Sales Desk/ })
      .click();
    const row = page.getByText("Corvane Fasteners price list.xlsx").locator("..");
    const download = page.waitForEvent("download");
    await row.getByRole("button", { name: "Download" }).click();
    expect((await download).suggestedFilename()).toBe("Corvane Fasteners price list.xlsx");
  });

  test("pause and resume the bot", async ({ page }) => {
    await login(page, "operator");
    await openConversations(page);
    await page.getByLabel("Search by name, supplier or phone").fill("Norvale");
    await inbox(page)
      .getByRole("link", { name: /Norvale Electric Supply/ })
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
      .getByRole("link", { name: /Louis Fernandez/ })
      .click();
    await page.getByLabel("Your reply").fill("Yes, we have 4 in stock. Shall I hold one for you?");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Sent. The bot stays paused")).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Messages" }).getByText("Yes, we have 4 in stock."),
    ).toBeVisible();
  });

  test("an operator records an opt-out; opting back in is admin-only", async ({ page }) => {
    await login(page, "operator");
    await openConversations(page);
    await inbox(page)
      .getByRole("link", { name: /Martha Silva/ })
      .click();
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: /Record opt-out/ }).click();
    await page.getByLabel("Reason (required)").fill("Called and asked us not to write");
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByText("Opt-out recorded")).toBeVisible();
    await expect(page.getByText("Opted out").first()).toBeVisible();
    await page.getByRole("button", { name: "More actions" }).click();
    await expect(page.getByRole("menuitem", { name: /for administrators only/ })).toBeVisible();
  });
});
