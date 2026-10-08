import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { E2E } from "./env";

/**
 * WhatsApp digest deep link (phase 9 M7): /d/<token> requires login (and comes back to the
 * link after it), the token is random (not the digest id), the URL carries no content.
 * Tokens are read from the E2E database (the seed creates two sent digests).
 */

// `pg` lives in the API package: borrow it for this test only.
interface PgClient {
  connect(): Promise<void>;
  query<R>(sql: string): Promise<{ rows: R[] }>;
  end(): Promise<void>;
}
const pg = createRequire(resolve(process.cwd(), "../api/package.json"))("pg") as {
  Client: new (options: { connectionString: string }) => PgClient;
};

async function digestTokens(): Promise<{ multi: string; single: string; id: string }> {
  const client = new pg.Client({ connectionString: E2E.databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string; link_token: string; n: number }>(
      `SELECT d.id, d.link_token, count(i.*)::int AS n
         FROM notification_digests d JOIN notification_items i ON i.digest_id = d.id
        WHERE d.link_token IS NOT NULL GROUP BY d.id ORDER BY n DESC`,
    );
    return { multi: rows[0]!.link_token, single: rows.at(-1)!.link_token, id: rows[0]!.id };
  } finally {
    await client.end();
  }
}

async function loginHere(page: Page) {
  await expect(page).toHaveURL(/\/login\?next=%2Fd%2F/);
  await page.getByLabel("Email").fill(E2E.operator.email);
  await page.getByLabel("Password").fill(E2E.operator.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

test.describe("digest deep link (phase 9 M7)", () => {
  test("logged out → login → back to the digest; its items link to the panel", async ({ page }) => {
    const { multi, id } = await digestTokens();
    expect(multi).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(multi).not.toContain(id);
    await page.goto(`/d/${multi}`);
    await loginHere(page);
    await expect(page.getByRole("heading", { name: "WhatsApp summary" })).toBeVisible();
    const list = page.getByRole("list", { name: "Summary items" });
    await expect(list.getByRole("link")).toHaveCount(3);
    await list.getByRole("link", { name: /Order from Anna Pearson/ }).click();
    await expect(page.getByRole("heading", { name: "Anna Pearson" })).toBeVisible();
  });

  test("a digest with one point opens it directly", async ({ page }) => {
    const { single } = await digestTokens();
    await page.goto(`/d/${single}`);
    await loginHere(page);
    await expect(page.getByRole("heading", { name: "Louis Fernandez" })).toBeVisible();
    await expect(page).toHaveURL(/\/conversations\//);
  });

  test("an unknown token says so (same answer as a malformed one)", async ({ page }) => {
    await page.goto(`/d/${"x".repeat(43)}`);
    await loginHere(page);
    await expect(page.getByText(/This no longer exists/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Go home" })).toBeVisible();
  });
});
