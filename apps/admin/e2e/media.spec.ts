import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";
import { CAPTIONS, toSrt, type CaptionId } from "./media-captions";

/**
 * README media (phase 13 M6), NOT an assertion suite: run with MEDIA=1 on a fresh E2E database.
 *   MEDIA=1 pnpm --filter @smartops/admin e2e media.spec.ts --project desktop --project iphone
 * - screenshots: English, light + dark, desktop 1440×900 and iPhone 15 → e2e/screens/media/*.png
 * - video (desktop): the demo flow with English captions drawn in the page (MEDIA_CAPTIONS=1,
 *   for the README GIF) or clean with measured times → .en.srt / .es.srt (for the MP4).
 * scripts/media/build-media.sh turns them into docs/media/ and the portfolio kit.
 */
test.skip(!process.env.MEDIA, "set MEDIA=1 to produce the README media");

const OUT = "e2e/screens/media";
mkdirSync(OUT, { recursive: true });

async function settle(page: Page) {
  // (never "networkidle": the real-time stream stays open, ADR-020)
  await page.getByRole("heading", { level: 1 }).first().waitFor();
  await expect(page.getByRole("status").filter({ hasText: "Live" })).toBeVisible();
  await page.waitForTimeout(700);
}

test("screenshots, light and dark", async ({ page, isMobile }, info) => {
  test.setTimeout(300_000);
  const shoot = async (name: string) => {
    await page.screenshot({ path: `${OUT}/${info.project.name}-${name}.png` });
  };
  await login(page, "admin");
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/");
    await settle(page);
    await shoot(`dashboard-${scheme}`);

    await page.goto("/revisiones");
    await settle(page);
    if (isMobile) await shoot(`reviews-${scheme}`);
    await page
      .getByRole("list", { name: "Reviews" })
      .getByText("Lista Distribuidora Norte.xlsx")
      .click();
    await settle(page);
    await shoot(`review-columns-${scheme}`);

    await page.goto("/conversaciones");
    await settle(page);
    // Phones: the inbox with its "who is answering" badges (a chat opens at its newest message).
    if (isMobile) await shoot(`inbox-${scheme}`);
    await page.getByLabel("Search by name, supplier or phone").fill(isMobile ? "Luis" : "Norte");
    await page.getByRole("list", { name: "Conversations" }).getByRole("link").first().click();
    await page.getByRole("region", { name: "Messages" }).waitFor();
    await settle(page);
    await shoot(`chat-${scheme}`);

    if (!isMobile) {
      await page.goto("/catalogo");
      await settle(page);
      await page.getByLabel("Search product").fill("tornillo 6mm");
      await page.getByRole("list", { name: "Products" }).getByRole("link").first().click();
      await page.getByRole("heading", { name: "Price history" }).waitFor();
      await settle(page);
      await shoot(`product-${scheme}`);
    }
  }
});

test("demo video", async ({ browser, isMobile }) => {
  test.skip(isMobile, "the video is recorded on desktop");
  test.setTimeout(420_000);
  const captions = process.env.MEDIA_CAPTIONS === "1";
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: `${OUT}/raw`, size: { width: 1440, height: 900 } },
    colorScheme: "light",
    locale: "en-US",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const start = Date.now();
  const steps: { id: CaptionId; at: number }[] = [];
  // The caption on screen now: re-drawn after every navigation (a new document drops it).
  let current = "";
  page.on("load", () => {
    if (captions && current) void draw(current).catch(() => undefined);
  });
  const say = async (id: CaptionId) => {
    steps.push({ id, at: Date.now() - start });
    if (!captions) return;
    current = CAPTIONS[id].en;
    await draw(current);
  };
  const draw = (caption: string) =>
    page.evaluate((text) => {
      let el = document.getElementById("media-caption");
      if (!el) {
        el = document.createElement("div");
        el.id = "media-caption";
        el.setAttribute(
          "style",
          "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;" +
            "max-width:80%;padding:12px 22px;border-radius:12px;background:rgba(15,23,42,.88);" +
            "color:#fff;font:600 22px/1.35 system-ui,sans-serif;text-align:center;" +
            "box-shadow:0 8px 24px rgba(0,0,0,.25);pointer-events:none",
        );
        document.body.appendChild(el);
      }
      el.textContent = text;
    }, caption);
  const pause = (ms: number) => page.waitForTimeout(ms);

  // 1. Sign in with the public demo card.
  await page.goto("/login");
  await page.getByText("Public demo.").waitFor();
  await say("login");
  await pause(2_500);
  await page.getByRole("button", { name: "Use these details" }).click();
  await pause(800);
  await page.getByRole("button", { name: "Sign in" }).click();
  await settle(page);
  await say("dashboard");
  await pause(3_500);

  // 2. A photo of a printed list through the real pipeline.
  await page.goto("/probar");
  await settle(page);
  await say("photo");
  await pause(2_000);
  await page.getByRole("button", { name: "Send a photo of a price list" }).click();
  await say("pipeline");
  const outcome = page
    .getByRole("region", { name: "Sample messages sent" })
    .getByRole("status")
    .first();
  await expect(outcome).toHaveText(/Catalog up to date|lines? to review/, { timeout: 90_000 });
  await pause(2_500);

  // 3. The catalog with the new prices and their history.
  await page.goto("/catalogo");
  await settle(page);
  await page.getByLabel("Search product").fill("tornillo 6mm");
  await page.getByRole("list", { name: "Products" }).getByRole("link").first().click();
  await page.getByRole("heading", { name: "Price history" }).waitFor();
  await say("catalog");
  await pause(3_500);

  // 4. A spreadsheet in a new format → a person picks the price column.
  await page.goto("/probar");
  await settle(page);
  await say("sheet");
  await page.getByRole("button", { name: "Send a new spreadsheet" }).click();
  await expect(outcome).toHaveText(/new format/, { timeout: 90_000 });
  await pause(1_500);
  await page.getByRole("link", { name: "Choose the column" }).first().click();
  await page
    .getByRole("list", { name: "Reviews" })
    .getByText("Precios Mayorista del Este.xlsx")
    .click();
  await page.getByRole("heading", { name: "Choose the price column" }).waitFor();
  await say("column");
  await pause(3_500);

  // 5. A chat handled by a person.
  await page.goto("/conversaciones");
  await settle(page);
  await page.getByLabel("Search by name, supplier or phone").fill("Luis");
  await page.getByRole("list", { name: "Conversations" }).getByRole("link").first().click();
  await page.getByRole("region", { name: "Messages" }).waitFor();
  await say("chat");
  await pause(3_500);

  // 6. The same panel in Spanish.
  await Promise.all([page.waitForEvent("load"), page.getByLabel("Language").selectOption("es")]);
  await page.getByRole("heading", { level: 1 }).first().waitFor();
  await say("language");
  await pause(3_000);
  const end = Date.now() - start;

  await context.close();
  const variant = captions ? "captions" : "clean";
  copyFileSync(await page.video()!.path(), `${OUT}/demo-${variant}.webm`);
  if (!captions) {
    writeFileSync(`${OUT}/demo-clean.en.srt`, toSrt(steps, end, "en"));
    writeFileSync(`${OUT}/demo-clean.es.srt`, toSrt(steps, end, "es"));
  }
  writeFileSync(`${OUT}/demo-${variant}.json`, JSON.stringify({ steps, end }, null, 2));
});
