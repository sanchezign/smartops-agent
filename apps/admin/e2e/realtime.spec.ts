import { expect, request, test } from "@playwright/test";
import { E2E } from "./env";
import { login } from "./helpers";

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
  await expect(page.getByRole("status").filter({ hasText: "En vivo" })).toBeVisible();

  await page.getByRole("link", { name: "Conversaciones", exact: true }).click();
  await page.getByLabel("Buscar por nombre, proveedor o teléfono").fill("Carolina");
  await page.getByRole("list", { name: "Conversaciones" }).getByRole("link").first().click();
  await expect(page.getByRole("heading", { name: "Carolina (depósito)" })).toBeVisible();
  const conversationId = new URL(page.url()).pathname.split("/").pop()!;

  // Every project runs this on the same chat: flip whatever mode it is in now.
  const { ctx, call } = await adminApi();
  const human = await page.getByRole("button", { name: "Reactivar el bot" }).isVisible();
  const change = human
    ? call("post", `/conversations/${conversationId}/resume`)
    : call("post", `/conversations/${conversationId}/pause`, { minutes: 30 });
  const changed = await change;
  expect(changed.ok(), `${changed.status()} ${await changed.text()}`).toBe(true);

  const expected = human ? "Responde el bot" : "Atiende una persona";
  await expect(page.getByText(expected).first()).toBeVisible({ timeout: 5_000 });
  await ctx.dispose();
});

test("a review resolved elsewhere leaves the open queue live", async ({ page, isMobile }) => {
  test.skip(isMobile, "resolves shared demo data: desktop only");
  await login(page);
  await page.getByRole("link", { name: "Revisiones", exact: true }).click();
  const list = page.getByRole("list", { name: "Revisiones" });
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
