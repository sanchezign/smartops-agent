import { expect, test } from "@playwright/test";
import { login, navLink } from "./helpers";

/**
 * User rule (after M2): at least one test PER BROWSER approves and rejects a review with the
 * buttons pinned at the bottom of the screen. The E2E seed (DEMO_E2E_REVIEWS) gives each
 * Playwright project its own two reviews: "Martillo <project>" and "Saw <project>".
 */

test("approve one review and reject another with the bottom buttons", async ({
  page,
  isMobile,
}, info) => {
  // iphone-chromium (local, phase 14) shares the seeded reviews of the iphone project.
  const project = info.project.name === "iphone-chromium" ? "iphone" : info.project.name;
  await login(page, "operator");
  await navLink(page, "Reviews").click();
  await page.getByRole("button", { name: /^Products/ }).click();
  const list = page.getByRole("list", { name: "Reviews" });

  await list.getByText(`Hammer ${project}`).click();
  const approve = page.getByRole("button", { name: "Apply price" });
  // Pinned to the bottom on phones: reachable without scrolling (desktop: normal flow).
  if (isMobile) await expect(approve).toBeInViewport();
  await approve.click();
  await expect(page.getByText("Approved and applied.")).toBeVisible();

  await page.getByRole("button", { name: /^Products/ }).click();
  await list.getByText(`Saw ${project}`).click();
  const reject = page.getByRole("button", { name: "Reject", exact: true });
  if (isMobile) await expect(reject).toBeInViewport();
  await reject.click();
  await page.getByLabel("Note").fill(`Precio equivocado (${project})`);
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("Review rejected")).toBeVisible();

  await page.getByRole("button", { name: "Rejected" }).click();
  await expect(list.getByText(`Saw ${project}`)).toBeVisible();
});
