import { expect, request, test } from "@playwright/test";
import { E2E } from "./env";
import { login, navLink } from "./helpers";

/**
 * Real time (phase 9 M4, ADR-020): a change made by ANOTHER session (here: the admin through
 * the API) shows up on the open screen without reloading, well before the 30 s fallback poll.
 * The stream goes through the same /api proxy as every call (Next rewrite; Caddy in prod).
 */

async function adminApi() {
  const ctx = await request.newContext({ baseURL: E2E.panelUrl });
  const res = await ctx.post("/api/v1/auth/login", {
    headers: { "x-smartops-csrf": "1", origin: E2E.panelUrl },
    data: { email: E2E.admin.email, password: E2E.admin.password },
  });
  expect(res.ok()).toBe(true);
  const { accessToken } = (await res.json()) as { accessToken: string };
  const call = (method: "get" | "post", path: string, data?: unknown) =>
    ctx[method](`/api/v1/admin${path}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      ...(data !== undefined ? { data } : {}),
    });
  return { ctx, call };
}

test("a mode change made elsewhere appears live in the open chat", async ({ page }) => {
  await login(page, "operator");
  await expect(page.getByRole("status").filter({ hasText: "Live" })).toBeVisible();

  await navLink(page, "Conversations").click();
  await page.getByLabel("Search by name, supplier or phone").fill("Carolina");
  // (by name: clicking "the first link" could hit the list before the search filtered it)
  await page
    .getByRole("list", { name: "Conversations" })
    .getByRole("link", { name: /Carolina/ })
    .click();
  await expect(page.getByRole("heading", { name: "Carolina (depósito)" })).toBeVisible();
  const conversationId = new URL(page.url()).pathname.split("/").pop()!;

  // Every project runs this on the same chat: flip whatever mode it is in now.
  const { ctx, call } = await adminApi();
  const human = await page.getByRole("button", { name: "Reactivate the bot" }).isVisible();
  const change = human
    ? call("post", `/conversations/${conversationId}/resume`)
    : call("post", `/conversations/${conversationId}/pause`, { minutes: 30 });
  const changed = await change;
  expect(changed.ok(), `${changed.status()} ${await changed.text()}`).toBe(true);

  const expected = human ? "The bot answers" : "A person is handling it";
  await expect(page.getByText(expected).first()).toBeVisible({ timeout: 5_000 });
  await ctx.dispose();
});

test("if the stream never answers: 'Updating every 30 s' and the screen still refreshes", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "one browser is enough for the fallback");
  test.setTimeout(120_000);
  // A proxy that holds the stream forever (like Cloudflare did with GET): never answer it.
  await page.route("**/api/v1/events", () => {});
  await login(page, "operator");
  await expect(page.getByRole("status").filter({ hasText: "Updating every 30 s" })).toBeVisible({
    timeout: 15_000,
  });
  await navLink(page, "Conversations").click();
  await page.getByLabel("Search by name, supplier or phone").fill("Carolina");
  await page
    .getByRole("list", { name: "Conversations" })
    .getByRole("link", { name: /Carolina/ })
    .click();
  await expect(page.getByRole("heading", { name: "Carolina (depósito)" })).toBeVisible();
  const conversationId = new URL(page.url()).pathname.split("/").pop()!;
  const human = await page.getByRole("button", { name: "Reactivate the bot" }).isVisible();
  const { ctx, call } = await adminApi();
  const changed = await (human
    ? call("post", `/conversations/${conversationId}/resume`)
    : call("post", `/conversations/${conversationId}/pause`, { minutes: 30 }));
  expect(changed.ok()).toBe(true);
  // The periodic refresh (30 s) brings it in without reloading.
  await expect(
    page.getByText(human ? "The bot answers" : "A person is handling it").first(),
  ).toBeVisible({
    timeout: 45_000,
  });
  await ctx.dispose();
});

test("a review resolved elsewhere leaves the open queue live", async ({ page, isMobile }) => {
  test.skip(isMobile, "resolves shared demo data: desktop only");
  await login(page);
  await navLink(page, "Reviews").click();
  const list = page.getByRole("list", { name: "Reviews" });
  await expect(list.getByText("Disyuntor diferencial 40A")).toBeVisible();

  const { ctx, call } = await adminApi();
  const { items } = (await (await call("get", "/reviews?scope=line")).json()) as {
    items: { id: string; proposal: { item: { name: string } } }[];
  };
  const review = items.find((i) => i.proposal.item.name === "Disyuntor diferencial 40A")!;
  expect((await call("post", `/reviews/${review.id}/reject`, { note: "e2e realtime" })).ok()).toBe(
    true,
  );
  await expect(list.getByText("Disyuntor diferencial 40A")).toHaveCount(0, { timeout: 5_000 });
  await ctx.dispose();
});
