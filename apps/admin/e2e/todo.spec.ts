import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, request, test } from "@playwright/test";
import { E2E } from "./env";
import { expectAccessible, login, navLink, openTodo } from "./helpers";

/**
 * To do (phase 15, ADR-032): one place for what waits for a person, ONE counter in the
 * navigation (what THIS user can resolve), action alerts with their chat, the empty state.
 */

async function apiAs(who: "operator" | "admin") {
  const ctx = await request.newContext({ baseURL: E2E.panelUrl });
  const res = await ctx.post("/api/v1/auth/login", {
    headers: { "x-smartops-csrf": "1", origin: E2E.panelUrl },
    data: { email: E2E[who].email, password: E2E[who].password },
  });
  expect(res.ok()).toBe(true);
  const { accessToken } = (await res.json()) as { accessToken: string };
  const get = async <T>(path: string) => {
    const r = await ctx.get(`/api/v1/admin${path}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(r.ok()).toBe(true);
    return (await r.json()) as T;
  };
  return { ctx, get };
}

// `pg` lives in the API package: borrow it to create an alert of this test's own.
interface PgClient {
  connect(): Promise<void>;
  query<R>(sql: string, values?: unknown[]): Promise<{ rows: R[] }>;
  end(): Promise<void>;
}
const pg = createRequire(resolve(process.cwd(), "../api/package.json"))("pg") as {
  Client: new (options: { connectionString: string }) => PgClient;
};

test.describe("to do (phase 15)", () => {
  test("the navigation counter is what THIS user can resolve (operator vs admin)", async ({
    page,
  }) => {
    for (const who of ["operator", "admin"] as const) {
      const api = await apiAs(who);
      const { total } = await api.get<{ total: number }>("/todo/summary");
      await api.ctx.dispose();
      await page.context().clearCookies();
      await login(page, who);
      await expect(
        page.getByRole("link", { name: new RegExp(`(^| )${total} pending`) }).first(),
      ).toBeVisible();
    }
  });

  test("the long voice note: in Messages to check, with the way to listen to it", async ({
    page,
  }) => {
    await login(page, "operator");
    await openTodo(page);
    const messages = page.getByRole("list", { name: "Messages to check" });
    const row = messages.getByRole("listitem").filter({ hasText: /Voice note of 4:12/ });
    await expect(row).toBeVisible();
    await expect(row.getByRole("button", { name: /^Done: / })).toBeVisible();
    await row.getByRole("link", { name: "Listen in the chat" }).click();
    await expect(page).toHaveURL(/\/conversations\//);
    await expect(page.getByRole("heading", { name: "Tessaly Paint & Coatings" })).toBeVisible();
  });

  test("All caught up: nothing to decide reads as reassurance, not as an empty box", async ({
    page,
  }) => {
    const empty = {
      counts: { total: 0, reviews: { canResolve: 0, waitingForAdmin: 0 }, alerts: 0 },
      groups: [],
      groupsTruncated: false,
      alerts: [],
    };
    await page.route("**/api/v1/admin/todo", (route) => route.fulfill({ json: empty }));
    await page.route("**/api/v1/admin/todo/summary", (route) =>
      route.fulfill({ json: empty.counts }),
    );
    await login(page, "operator");
    await openTodo(page);
    await expect(page.getByText("All caught up")).toBeVisible();
    await expect(
      page.getByText("Everything that arrived was processed on its own.", { exact: false }),
    ).toBeVisible();
    // No counter anywhere when nothing waits.
    await expect(page.getByRole("link", { name: /pending/ })).toHaveCount(0);
    await expectAccessible(page);
  });

  test("System status: read-only for the demo operator, with the button for an admin", async ({
    page,
    isMobile,
  }) => {
    await login(page, "operator");
    if (isMobile) await page.getByRole("button", { name: "More" }).click();
    await navLink(page, "System status").click();
    await expect(page.getByRole("heading", { name: "System status", level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: /Mark as seen/ })).toHaveCount(0);
    await expectAccessible(page);
  });
});

test.describe("to do: acting on a message (desktop only: it changes the shared demo data)", () => {
  test.skip(({ isMobile }) => isMobile, "mutations run once, on desktop");

  test("Done closes a voice note to listen to; the counter goes down by one", async ({ page }) => {
    // Its own alert, so the seeded one stays for the other browsers.
    const db = new pg.Client({ connectionString: E2E.databaseUrl });
    await db.connect();
    try {
      await db.query(
        `INSERT INTO alerts (id, type, severity, status, title, payload, created_at, updated_at)
         VALUES (gen_random_uuid(), 'manual_attention', 'info', 'open', 'e2e voice note',
                 '{"reason":"audio_too_long","durationSeconds":421,"maxSeconds":180}', now(), now())`,
      );
    } finally {
      await db.end();
    }
    const api = await apiAs("operator");
    const before = (await api.get<{ total: number }>("/todo/summary")).total;
    await login(page, "operator");
    await openTodo(page);
    const row = page
      .getByRole("list", { name: "Messages to check" })
      .getByRole("listitem")
      .filter({ hasText: /Voice note of 7:01/ });
    await row.getByRole("button", { name: /^Done: / }).click();
    await expect(row).toHaveCount(0);
    await expect
      .poll(async () => (await api.get<{ total: number }>("/todo/summary")).total)
      .toBe(before - 1);
    await expect(
      page.getByRole("link", { name: new RegExp(`(^| )${before - 1} pending`) }).first(),
    ).toBeVisible();
    await api.ctx.dispose();
  });
});
