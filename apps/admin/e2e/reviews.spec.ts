import { expect, test } from "@playwright/test";
import { expectAccessible, login, openTodo, todoEntry } from "./helpers";

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

  test("an operator: what only an admin resolves is folded, with why, and read-only", async ({
    page,
    isMobile,
  }) => {
    await login(page, "operator");
    await openTodo(page);
    const waiting = page.locator("main details");
    await expect(waiting).toHaveCount(1);
    await expect(waiting).not.toHaveAttribute("open"); // folded by default
    await expect(waiting.locator("summary")).toHaveText(/^Waiting for an administrator \(\d+\)$/);
    await waiting.locator("summary").click();
    await expect(
      page.getByText("each one affects a whole list or the entire catalog", { exact: false }),
    ).toBeVisible();
    await expectAccessible(page);
    await (await todoEntry(page, "Suspicious message")).click();
    await expect(page.getByRole("heading", { name: "Suspicious message" })).toBeVisible();
    // Where the buttons would be (pinned at the bottom on phones): no hunting for buttons.
    const notice = page.getByText("Only an administrator can resolve this review.");
    await expect(notice).toBeVisible();
    if (isMobile) await expect(notice).toBeInViewport();
    await expect(page.getByRole("button", { name: "Process anyway" })).toHaveCount(0);
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
