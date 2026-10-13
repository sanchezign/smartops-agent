import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, request, test } from "@playwright/test";
import { E2E } from "./env";
import { expectAccessible, login, navLink, openTodo, todoEntry } from "./helpers";

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

  test("each decision in ONE place; what is shown adds up to the counters (operator)", async ({
    page,
  }, info) => {
    // Its own list (another spec may resolve the seeded ones first): one decision for the
    // operator and one only an admin can take.
    const mixed = await insertReview({
      product: "Cut-off wheel 4-1/2 in",
      scope: "line",
      kind: "price_outlier",
      reasons: ["price_outlier"],
      proposed: { price: "2.95" },
      tag: `mixed-${info.project.name}`,
    });
    await insertReview({
      product: "Nitrile gloves, size M",
      scope: "catalog",
      kind: "mark_unavailable",
      reasons: ["missing_from_full_list"],
      tag: `mixed-${info.project.name}`,
      runId: mixed.runId,
    });
    await login(page, "operator");
    await openTodo(page);
    const pendingOf = async (cards: ReturnType<typeof page.getByRole>) =>
      (await cards.getByRole("article").locator("header p").allTextContents()).reduce(
        (n, meta) => n + Number(/(\d+) pending/.exec(meta)?.[1] ?? Number.NaN),
        0,
      );
    // The cards above hold only what the operator can resolve: no across-the-board change there.
    const lists = page.getByRole("list", { name: "Price lists" });
    // (the heading renders before the data: wait for both lists before counting anything)
    await expect(lists.getByRole("article").first()).toBeVisible();
    await expect(page.getByRole("list", { name: "Messages to check" })).toBeVisible();
    await expect(lists.getByText("Across-the-board change")).toHaveCount(0);
    // What is visible above + the messages to check = the navigation counter.
    const messages = await page
      .getByRole("list", { name: "Messages to check" })
      .getByRole("listitem")
      .count();
    // The badge's screen-reader text ("12 pending"); textContent also works where it is hidden.
    const badgeText = await navLink(page, "To do").first().locator(".sr-only").textContent();
    const badge = Number(/(\d+) pending/.exec(badgeText ?? "")?.[1]);
    expect((await pendingOf(lists)) + messages).toBe(badge);
    // A list with an admin-only item says so and leads to the section, which opens.
    const card = lists.getByRole("article").filter({ hasText: "Cut-off wheel 4-1/2 in" }).first();
    await expect(card.getByText("Nitrile gloves")).toHaveCount(0);
    await card.getByRole("link", { name: "+1 waits for an administrator" }).click();
    const waiting = page.getByRole("list", { name: "Waiting for an administrator" });
    await expect(
      waiting.getByText("Mark Nitrile gloves, size M as unavailable?").first(),
    ).toBeInViewport();
    await expect(waiting.getByText("Across-the-board change").first()).toBeVisible();
    // The section's N is exactly what it shows.
    const summary = await page.locator("main details summary").innerText();
    expect(Number(/\((\d+)\)/.exec(summary)?.[1])).toBe(await pendingOf(waiting));
    await expectAccessible(page);
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

  test("System status: read-only for the demo operator, with the reason why", async ({
    page,
    isMobile,
  }) => {
    await login(page, "operator");
    if (isMobile) await page.getByRole("button", { name: "More" }).click();
    await navLink(page, "System status").click();
    await expect(page.getByRole("heading", { name: "System status", level: 1 })).toBeVisible();
    await expect(
      page.getByText("only an administrator marks errors as reviewed", { exact: false }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /Mark as reviewed/ })).toHaveCount(0);
    // The seeded n8n error was reviewed: grey, "Reviewed".
    await expect(
      page.getByRole("main").getByText("Reviewed", { exact: true }).first(),
    ).toBeVisible();
    await expectAccessible(page);
  });

  test("System status: an admin marks an unreviewed error as reviewed (danger → grey)", async ({
    page,
  }, info) => {
    const title = `e2e n8n error ${info.project.name}`;
    const db = new pg.Client({ connectionString: E2E.databaseUrl });
    await db.connect();
    try {
      await db.query(
        `INSERT INTO alerts (id, type, severity, status, title, payload, created_at, updated_at)
         VALUES (gen_random_uuid(), 'integration_error', 'critical', 'open', $1, '{}', now(), now())`,
        [title],
      );
    } finally {
      await db.end();
    }
    await login(page, "admin");
    await page.goto("/system");
    await expect(page.getByRole("heading", { name: "System status", level: 1 })).toBeVisible();
    await expect(page.getByText("only an administrator", { exact: false })).toHaveCount(0);
    const row = page.getByRole("main").getByRole("listitem").filter({ hasText: title });
    await expect(row.getByText("Not reviewed")).toBeVisible();
    await expectAccessible(page);
    await row.getByRole("button", { name: `Mark as reviewed: ${title}` }).click();
    await expect(row.getByText("Reviewed", { exact: true })).toBeVisible();
    await expect(row.getByRole("button")).toHaveCount(0);
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

/**
 * One-click decisions (phase 15 M3, ADR-032 §3). Every browser project runs them on reviews it
 * creates for itself (projects run one after the other on the same database), with the proposal
 * the catalog writes: the product's CURRENT price as the base, a proposed price, one reason. Each
 * review is its own new list (a message of the supplier's chat + an ingestion run), the newest
 * card of To do — never hidden behind another list's "View all".
 */
async function insertReview(input: {
  product: string;
  scope: "line" | "catalog";
  kind: "price_outlier" | "currency_changed" | "mark_unavailable" | "stale_source";
  reasons: string[];
  proposed?: { price: string; currency?: string };
  tag: string;
  /** Add it to this list instead of a new one. */
  runId?: string;
}) {
  const db = new pg.Client({ connectionString: E2E.databaseUrl });
  await db.connect();
  try {
    const { rows } = await db.query<{
      id: string;
      supplier_id: string;
      price: string;
      currency: string;
      conversation_id: string;
    }>(
      `SELECT p.id, p.supplier_id, p.price::text AS price, p.currency,
              (SELECT c.id FROM conversations c JOIN contacts k ON k.id = c.contact_id
                WHERE k.supplier_id = p.supplier_id LIMIT 1) AS conversation_id
         FROM products p WHERE p.name = $1 LIMIT 1`,
      [input.product],
    );
    const p = rows[0]!;
    let runId = input.runId;
    if (!runId) {
      const message = await db.query<{ id: string }>(
        `INSERT INTO messages (id, conversation_id, direction, type, author, text, wa_timestamp,
                               created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'inbound', 'text', 'contact', $2, now(), now(), now())
         RETURNING id`,
        [p.conversation_id, `${input.product} (e2e ${input.tag})`],
      );
      const run = await db.query<{ id: string }>(
        `INSERT INTO ingestion_runs (id, message_id, supplier_id, status, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'ingested', now(), now()) RETURNING id`,
        [message.rows[0]!.id, p.supplier_id],
      );
      runId = run.rows[0]!.id;
    }
    const currency = input.proposed?.currency ?? p.currency;
    const proposal =
      input.scope === "catalog"
        ? { reason: input.reasons[0] }
        : {
            lineIndex: 0,
            item: {
              name: input.product,
              sku: null,
              unit: null,
              price: input.proposed!.price,
              priceChangePct: null,
              currency,
              available: null,
              stock: null,
            },
            listCurrency: currency,
            messageAt: new Date().toISOString(),
            candidates: [],
            proposedPrice: input.proposed!.price,
            currency,
            changePct: null,
          };
    await db.query(
      `INSERT INTO review_items (id, ingestion_run_id, supplier_id, product_id, scope, kind, status,
                                 dedupe_key, reasons, proposal, base_price, base_currency,
                                 created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4::"ReviewScope", $5::"ReviewKind", 'pending',
               $6, $7::text[], $8::jsonb, $9::numeric, $10, now(), now())`,
      [
        runId,
        p.supplier_id,
        p.id,
        input.scope,
        input.kind,
        `e2e-quick:${input.tag}:${input.kind}:${Date.now()}`,
        input.reasons,
        JSON.stringify(proposal),
        p.price,
        p.currency,
      ],
    );
    return { productId: p.id, price: p.price, currency: p.currency, runId };
  } finally {
    await db.end();
  }
}

async function productState(productId: string) {
  const db = new pg.Client({ connectionString: E2E.databaseUrl });
  await db.connect();
  try {
    const { rows } = await db.query<{ price: string; available: boolean }>(
      `SELECT price::text AS price, available FROM products WHERE id = $1`,
      [productId],
    );
    return rows[0]!;
  } finally {
    await db.end();
  }
}

test.describe("to do: one-click decisions (phase 15 M3)", () => {
  test("Update to $X applies the price; Keep $Y leaves it as it was", async ({ page }, info) => {
    const tag = info.project.name;
    const updated = await insertReview({
      product: "Hex nut 1/4 in",
      scope: "line",
      kind: "price_outlier",
      reasons: ["price_outlier"],
      proposed: { price: "0.41" },
      tag,
    });
    const kept = await insertReview({
      product: "Common nail 2 in",
      scope: "line",
      kind: "price_outlier",
      reasons: ["price_outlier"],
      proposed: { price: "4.99" },
      tag,
    });
    await login(page, "operator");
    await openTodo(page);

    const nut = page.getByRole("group", { name: "Decision on Hex nut 1/4 in" });
    // Concrete verbs with the value — never "Yes / No".
    await expect(nut.getByRole("button", { name: /^Update to \$0\.41$/ })).toBeVisible();
    await expect(nut.getByRole("button", { name: /^Keep \$/ })).toBeVisible();
    await expect(page.getByRole("main").getByRole("button", { name: /^(Yes|No)$/ })).toHaveCount(0);
    await expectAccessible(page);
    await nut.getByRole("button", { name: /^Update to \$0\.41$/ }).click();
    await expect(page.getByText(/^Hex nut 1\/4 in: updated to \$0\.41\.$/)).toBeVisible();
    await expect(nut).toHaveCount(0);
    await expect.poll(async () => Number((await productState(updated.productId)).price)).toBe(0.41);

    const nail = page.getByRole("group", { name: "Decision on Common nail 2 in" });
    await nail.getByRole("button", { name: /^Keep \$/ }).click();
    await expect(page.getByText(/^Common nail 2 in: stays at /)).toBeVisible();
    await expect(nail).toHaveCount(0);
    expect(Number((await productState(kept.productId)).price)).toBe(Number(kept.price));
  });

  test("currency_changed shows both currencies on its buttons", async ({ page }, info) => {
    await insertReview({
      product: "Galvanized wire 14 ga",
      scope: "line",
      kind: "currency_changed",
      reasons: ["currency_changed"],
      proposed: { price: "150", currency: "UYU" },
      tag: info.project.name,
    });
    await login(page, "operator");
    await openTodo(page);
    const wire = page.getByRole("group", { name: "Decision on Galvanized wire 14 ga" });
    await expect(wire.getByRole("button", { name: /^Change to UYU/ })).toBeVisible();
    await expect(wire.getByRole("button", { name: /^Keep \$/ })).toBeVisible();
    await wire.getByRole("button", { name: /^Keep \$/ }).click();
    await expect(wire).toHaveCount(0);
  });

  test("never one click for an older message (stale_source): it is decided in the detail", async ({
    page,
  }, info) => {
    await insertReview({
      product: "Tape measure 16 ft",
      scope: "line",
      kind: "stale_source",
      reasons: ["stale_source"],
      proposed: { price: "8.10" },
      tag: info.project.name,
    });
    await login(page, "operator");
    await openTodo(page);
    await expect(
      await todoEntry(page, "Apply an older price to “Tape measure 16 ft”?"),
    ).toBeVisible();
    await expect(page.getByRole("group", { name: "Decision on Tape measure 16 ft" })).toHaveCount(
      0,
    );
  });

  test("mark_unavailable: an admin keeps it available in one click; an operator only sees it waiting", async ({
    page,
  }, info) => {
    const sealant = await insertReview({
      product: "Silicone sealant, clear",
      scope: "catalog",
      kind: "mark_unavailable",
      reasons: ["missing_from_full_list"],
      tag: info.project.name,
    });
    await login(page, "operator");
    await openTodo(page);
    await expect(
      page.getByRole("group", { name: "Decision on Silicone sealant, clear" }),
    ).toHaveCount(0);
    await expect(
      await todoEntry(page, "Mark Silicone sealant, clear as unavailable?"),
    ).toBeVisible();

    await page.context().clearCookies();
    await login(page, "admin");
    await openTodo(page);
    const row = page.getByRole("group", { name: "Decision on Silicone sealant, clear" });
    await expect(row.getByRole("button", { name: "Mark unavailable" })).toBeVisible();
    await row.getByRole("button", { name: "Keep available" }).click();
    await expect(page.getByText("Silicone sealant, clear: stays available.")).toBeVisible();
    await expect(row).toHaveCount(0);
    expect((await productState(sealant.productId)).available).toBe(true);
  });

  test("a possible opt-out: Opt out asks first (cancel = nothing changes); Not an opt-out closes it", async ({
    page,
  }, info) => {
    const phrase = `please no more ${info.project.name}`;
    const db = new pg.Client({ connectionString: E2E.databaseUrl });
    await db.connect();
    try {
      await db.query(
        `INSERT INTO alerts (id, type, severity, status, title, payload, created_at, updated_at)
         SELECT gen_random_uuid(), 'possible_opt_out', 'info', 'open', 'e2e opt-out',
                jsonb_build_object('contactId', c.contact_id::text, 'messageId', m.id::text,
                                   'matched', $1::text),
                now(), now()
           FROM messages m JOIN conversations c ON c.id = m.conversation_id
           JOIN contacts k ON k.id = c.contact_id
          WHERE m.direction = 'inbound' AND k.kind = 'customer'
          ORDER BY m.created_at DESC LIMIT 1`,
        [phrase],
      );
    } finally {
      await db.end();
    }
    await login(page, "operator");
    await openTodo(page);
    const row = page
      .getByRole("list", { name: "Messages to check" })
      .getByRole("listitem")
      .filter({ hasText: phrase });
    await row.getByRole("button", { name: "Opt out" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Record this opt-out?" });
    await expect(
      dialog.getByText("Only an administrator can opt them back in.", { exact: false }),
    ).toBeVisible();
    await expectAccessible(page);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(row).toBeVisible(); // nothing was recorded
    await row.getByRole("button", { name: /^Not an opt-out: / }).click();
    await expect(row).toHaveCount(0);
  });
});
