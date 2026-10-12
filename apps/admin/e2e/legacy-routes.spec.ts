import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/** Old Spanish links keep working: permanent redirects to the English routes (phase 13). */
test.skip(({ isMobile }) => isMobile, "one browser is enough for redirects");

test("old routes redirect permanently, sub-paths included", async ({ page, request }) => {
  const res = await request.get("/revisiones?status=pending", { maxRedirects: 0 });
  expect(res.status()).toBe(308);
  expect(res.headers().location).toBe("/todo?status=pending"); // phase 15: straight to To do
  const review = await request.get("/revisiones/abc", { maxRedirects: 0 });
  expect(review.headers().location).toBe("/reviews/abc"); // a review's own page
  const alerts = await request.get("/alerts", { maxRedirects: 0 });
  expect(alerts.status()).toBe(308);
  expect(alerts.headers().location).toBe("/activity");
  const bajas = await request.get("/conversaciones/bajas", { maxRedirects: 0 });
  expect(bajas.headers().location).toBe("/conversations/opted-out");

  await login(page, "operator");
  await page.goto("/catalogo");
  await expect(page).toHaveURL(/\/catalog$/);
  await expect(page.getByRole("heading", { name: "Catalog", level: 1 })).toBeVisible();
});
