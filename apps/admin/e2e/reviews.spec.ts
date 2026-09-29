import { expect, test, type Page } from "@playwright/test";
import { expectAccessible, login } from "./helpers";

/**
 * Review queue (phase 9 M2) on the seeded demo. Projects run one after the other on the SAME
 * database, so tests that resolve a review run only on desktop; phones check reading and the
 * role rules on items nobody resolves.
 */

async function openReviews(page: Page, isMobile: boolean) {
  void isMobile; // sidebar on desktop, bottom bar on phones: the hidden one is not a link to click
  await page.getByRole("link", { name: "Reviews", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Reviews", level: 1 })).toBeVisible();
}

test.describe("review queue (phase 9 M2)", () => {
  test("lists every pending kind with counts per scope", async ({ page, isMobile }) => {
    await login(page);
    await openReviews(page, isMobile);
    const list = page.getByRole("list", { name: "Reviews" });
    await expect(list.getByText("Across-the-board change")).toBeVisible();
    await expect(list.getByText("Suspicious message")).toBeVisible();
    await expect(list.getByText("Mark as unavailable?")).toBeVisible();
    await page.getByRole("button", { name: /^Catalog/ }).click();
    await expect(list.getByText("Suspicious message")).toHaveCount(0);
    await expect(list.getByText("Across-the-board change")).toBeVisible();
    await expectAccessible(page);
  });

  test("a whole-list review is read-only for an operator", async ({ page, isMobile }) => {
    await login(page, "operator");
    await openReviews(page, isMobile);
    await page.getByRole("list", { name: "Reviews" }).getByText("Suspicious message").click();
    await expect(page.getByRole("heading", { name: "Suspicious message" })).toBeVisible();
    // Where the buttons would be (pinned at the bottom on phones): no hunting for buttons.
    const notice = page.getByText("Only an administrator can resolve this review.");
    await expect(notice).toBeVisible();
    if (isMobile) await expect(notice).toBeInViewport();
    await expect(page.getByRole("button", { name: "Process anyway" })).toHaveCount(0);
    await expectAccessible(page);
  });

  test("the global change shows every product before and after", async ({ page, isMobile }) => {
    await login(page);
    await openReviews(page, isMobile);
    await page.getByRole("list", { name: "Reviews" }).getByText("Across-the-board change").click();
    await expect(page.getByRole("columnheader", { name: "After" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Apply \+8%/ })).toBeVisible();
    await expectAccessible(page);
  });
});

test.describe("resolving reviews (desktop only: it changes the shared demo data)", () => {
  test.skip(({ isMobile }) => isMobile, "mutations run once, on desktop");

  test("spreadsheet: pick the price column with real values, approve → back to extraction", async ({
    page,
  }) => {
    await login(page);
    await openReviews(page, false);
    await page
      .getByRole("list", { name: "Reviews" })
      .getByText("Lista Distribuidora Norte.xlsx")
      .click();
    await expect(page.getByRole("heading", { name: "Choose the price column" })).toBeVisible();
    const group = page.getByRole("radiogroup", { name: /Price column/ });
    const withTax = group.getByRole("radio", { name: /Precio c\/IVA/ });
    await expect(withTax).toBeChecked(); // the recommendation is pre-selected…
    await expect(group.getByText("Suggested")).toBeVisible();
    await expect(group.getByText("320").first()).toBeVisible(); // …next to values from the file
    await expectAccessible(page);
    await group.getByRole("radio", { name: /Mayorista/ }).click();
    await page.getByRole("button", { name: "Use this column" }).click();
    await expect(page.getByText("The list is processed again")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Reviews", level: 1 })).toBeVisible();
    await expect(
      page.getByRole("list", { name: "Reviews" }).getByText("Lista Distribuidora Norte.xlsx"),
    ).toHaveCount(0);
  });

  test("line: correct the price and apply it (operator)", async ({ page }) => {
    await login(page, "operator");
    await openReviews(page, false);
    await page.getByRole("button", { name: /^Products/ }).click();
    await page.getByRole("list", { name: "Reviews" }).getByText("Arena gruesa").click();
    await expect(page.getByRole("heading", { name: /Unusual price change/ })).toBeVisible();
    await page.getByLabel("Price", { exact: true }).fill("1,900"); // ambiguous in English: thousands or decimals?
    await page.getByRole("button", { name: "Apply price" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "thousands separator" })).toBeVisible();
    await page.getByLabel("Price", { exact: true }).fill("1900");
    await page.getByRole("button", { name: "Apply price" }).click();
    await expect(page.getByText("Approved and applied.")).toBeVisible();
  });

  test("reject with a note", async ({ page }) => {
    await login(page);
    await openReviews(page, false);
    await page.getByRole("list", { name: "Reviews" }).getByText("Pintura látex blanca 4L").click();
    await page.getByRole("button", { name: "Reject" }).click();
    await page.getByLabel("Note").fill("No se entiende el audio: le pido que lo escriba");
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByText("Review rejected")).toBeVisible();
    await page.getByRole("button", { name: "Rejected" }).click();
    await expect(
      page.getByRole("list", { name: "Reviews" }).getByText("Pintura látex blanca 4L"),
    ).toBeVisible();
  });
});
