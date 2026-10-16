import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { E2E } from "./env";
import { expectAccessible, login, openTodo, todoEntry } from "./helpers";

// `pg` lives in the API package: borrow it to read the audit log (phase 16 M2, ADR-034).
interface PgClient {
  connect(): Promise<void>;
  query<R>(sql: string, values?: unknown[]): Promise<{ rows: R[] }>;
  end(): Promise<void>;
}
const pg = createRequire(resolve(process.cwd(), "../api/package.json"))("pg") as {
  Client: new (options: { connectionString: string }) => PgClient;
};

/** The audit-log rows of one review item, with the email of who resolved it. */
async function auditOf(reviewId: string) {
  const db = new pg.Client({ connectionString: E2E.databaseUrl });
  await db.connect();
  try {
    const { rows } = await db.query<{ action: string; actor_type: string; email: string | null }>(
      `SELECT a.action, a.actor_type, u.email
         FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
        WHERE a.entity = 'review_item' AND a.entity_id = $1
        ORDER BY a.created_at`,
      [reviewId],
    );
    return rows;
  } finally {
    await db.end();
  }
}

const REAL_ADMIN_NOTE = "In a real installation an administrator resolves this.";

/**
 * Reviews in To do (phase 9 M2, phase 15 ADR-032) on the seeded demo. Projects run one after the
 * other on the SAME database, so tests that resolve a review run only on desktop; phones check
 * reading and the role rules on items nobody resolves.
 */

test.describe("to do: reviews (phase 15)", () => {
  test("one card per list with where it came from; every pending kind", async ({ page }) => {
    await login(page);
    await openTodo(page);
    // An admin resolves everything: nothing is folded away.
    await expect(page.getByText(/^Waiting for an administrator/)).toHaveCount(0);
    for (const kind of ["Across-the-board change", "Suspicious message", "Mark as unavailable?"]) {
      await expect(await todoEntry(page, kind)).toBeVisible();
    }
    const card = page.getByRole("article", { name: "Corvane Fasteners Inc." }).first();
    await expect(card).toBeVisible();
    await expect(page.getByRole("main").getByText("Spreadsheet").first()).toBeVisible();
    await expectAccessible(page);
  });

  test("the demo operator (ADR-034): nothing is folded for an admin; admin-only reviews say so and can be resolved", async ({
    page,
  }) => {
    await login(page, "operator");
    await openTodo(page);
    // Nothing waits for an administrator in the public demo.
    await expect(page.locator("main details")).toHaveCount(0);
    await expect(page.getByText(/^Waiting for an administrator/)).toHaveCount(0);
    const entry = await todoEntry(page, "Suspicious message");
    await expect(entry).toBeVisible();
    await expect(entry.getByText(REAL_ADMIN_NOTE)).toBeVisible();
    await expectAccessible(page);
    await entry.click();
    await expect(page.getByRole("heading", { name: "Suspicious message" })).toBeVisible();
    await expect(page.getByRole("note").filter({ hasText: REAL_ADMIN_NOTE })).toBeVisible();
    await expect(page.getByText("Only an administrator can resolve this review.")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Process anyway" })).toBeVisible();
    await expectAccessible(page);
  });

  test("the global change shows every product before and after", async ({ page }) => {
    await login(page);
    await openTodo(page);
    await (await todoEntry(page, "Across-the-board change")).click();
    await expect(page.getByRole("columnheader", { name: "After" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Apply \+8%/ })).toBeVisible();
    await expectAccessible(page);
  });

  test("the old review list redirects to To do", async ({ page }) => {
    await login(page, "operator");
    await page.goto("/reviews");
    await expect(page).toHaveURL(/\/todo$/);
    await expect(page.getByRole("heading", { name: "To do", level: 1 })).toBeVisible();
  });
});

test.describe("resolving reviews (desktop only: it changes the shared demo data)", () => {
  test.skip(({ isMobile }) => isMobile, "mutations run once, on desktop");

  // ADR-034: the public operator resolves a whole-list gate and a catalog-wide change; each
  // resolution is in the audit log with the public operator as its author. On their own supplier
  // ("E2E Supplier gates", seeded for the E2E only) so no other test loses the seeded reviews.
  async function openGate(page: Page, kind: string) {
    await openTodo(page);
    const card = page
      .getByRole("article", { name: "E2E Supplier gates" })
      .filter({ hasText: kind });
    const link = card.getByRole("link").filter({ hasText: kind }).first();
    await expect(link.getByText(REAL_ADMIN_NOTE)).toBeVisible();
    await link.click();
    await expect(page.getByRole("heading", { name: kind })).toBeVisible();
    await expect(page.getByRole("note").filter({ hasText: REAL_ADMIN_NOTE })).toBeVisible();
    return /\/reviews\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  }
  const audited = async (id: string) =>
    (await auditOf(id)).map((r) => `${r.action} ${r.actor_type} ${r.email}`);

  test("ADR-034: the demo operator processes a suspicious message anyway; the audit log names the public operator", async ({
    page,
  }) => {
    await login(page, "operator");
    const id = await openGate(page, "Suspicious message");
    await page.getByRole("button", { name: "Process anyway" }).click();
    await expect(page.getByRole("heading", { name: "To do", level: 1 })).toBeVisible();
    await expect.poll(() => audited(id)).toEqual([`review.approve user ${E2E.operator.email}`]);
  });

  test("ADR-034: the demo operator applies an across-the-board change; the audit log names the public operator", async ({
    page,
  }) => {
    await login(page, "operator");
    const id = await openGate(page, "Across-the-board change");
    await page.getByRole("button", { name: /^Apply \+8/ }).click();
    await expect(page.getByRole("heading", { name: "To do", level: 1 })).toBeVisible();
    await expect.poll(() => audited(id)).toEqual([`review.approve user ${E2E.operator.email}`]);
  });

  // ADR-030: in the public demo the OPERATOR (the shared account every visitor uses) resolves this
  // review — the step the README video shows. The admin path is covered by the API tests.
  test("spreadsheet: the demo operator picks the price column with real values, approve → back to extraction", async ({
    page,
  }) => {
    await login(page, "operator");
    await openTodo(page);
    await (await todoEntry(page, "Corvane Fasteners price list.xlsx")).click();
    await expect(page.getByRole("heading", { name: "Choose the price column" })).toBeVisible();
    await expect(page.getByText("Only an administrator can resolve this review.")).toHaveCount(0);
    const group = page.getByRole("radiogroup", { name: /Price column/ });
    const withTax = group.getByRole("radio", { name: /Price inc tax/ });
    await expect(withTax).toBeChecked(); // the recommendation is pre-selected…
    await expect(group.getByText("Suggested")).toBeVisible();
    await expect(group.getByText("11.8").first()).toBeVisible(); // …next to values from the file
    await expectAccessible(page);
    await group.getByRole("radio", { name: /Wholesale/ }).click();
    await page.getByRole("button", { name: "Use this column" }).click();
    await expect(page.getByText("The list is processed again")).toBeVisible();
    await expect(page.getByRole("heading", { name: "To do", level: 1 })).toBeVisible();
    await expect(page.getByRole("main").getByText("Corvane Fasteners price list.xlsx")).toHaveCount(
      0,
    );
  });

  test("line: correct the price and apply it (operator); it shows in Resolved", async ({
    page,
  }) => {
    await login(page, "operator");
    await openTodo(page);
    await (await todoEntry(page, "Coarse sand")).click();
    await expect(page.getByRole("heading", { name: /Unusual price change/ })).toBeVisible();
    await page.getByLabel("Price", { exact: true }).fill("1,900"); // ambiguous in English: thousands or decimals?
    await page.getByRole("button", { name: "Apply price" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "thousands separator" })).toBeVisible();
    await page.getByLabel("Price", { exact: true }).fill("1900");
    await page.getByRole("button", { name: "Apply price" }).click();
    await expect(page.getByText("Approved and applied.")).toBeVisible();
    // The history the old Reviews status filter showed (phase 15): one click from To do.
    await page.getByRole("link", { name: "Resolved" }).click();
    await expect(page.getByRole("heading", { name: "Resolved", level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "Approved" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(
      page.getByRole("list", { name: "Resolved" }).getByText("Coarse sand"),
    ).toBeVisible();
    await expectAccessible(page);
  });

  test("reject with a note; it shows in Resolved → Rejected", async ({ page }) => {
    await login(page);
    await openTodo(page);
    await (await todoEntry(page, "Interior latex paint, white 1 gal")).click();
    await page.getByRole("button", { name: "Reject" }).click();
    await page.getByLabel("Note").fill("No se entiende el audio: le pido que lo escriba");
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByText("Review rejected")).toBeVisible();
    await expect(page.getByRole("main").getByText("Interior latex paint, white 1 gal")).toHaveCount(
      0,
    );
    await page.getByRole("link", { name: "Resolved" }).click();
    await page.getByRole("button", { name: "Rejected" }).click();
    await expect(
      page.getByRole("list", { name: "Resolved" }).getByText("Interior latex paint, white 1 gal"),
    ).toBeVisible();
  });
});
