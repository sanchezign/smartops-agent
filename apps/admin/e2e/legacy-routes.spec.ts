import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/** Old Spanish links keep working: permanent redirects to the English routes (phase 13). */
test.skip(({ isMobile }) => isMobile, "one browser is enough for redirects");

test("old routes redirect permanently, sub-paths included", async ({ page, request }) => {
  const res = await request.get("/revisiones?status=pending", { maxRedirects: 0 });
  expect(res.status()).toBe(308);
  expect(res.headers().location).toBe("/reviews?status=pending");
  const bajas = await request.get("/conversaciones/bajas", { maxRedirects: 0 });
  expect(bajas.headers().location).toBe("/conversations/opted-out");

  await login(page, "operator");
  await page.goto("/catalogo");
  await expect(page).toHaveURL(/\/catalog$/);
  await expect(page.getByRole("heading", { name: "Catalog", level: 1 })).toBeVisible();
});
