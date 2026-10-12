import { describe, expect, it } from "vitest";
import { canSeeSystem, isActive, navFor } from "../src/components/layout/nav-items";
import { listOrder, sourceKind } from "../src/features/reviews/source";
import type { SessionUser } from "../src/lib/api-client";

/** Phase 15 (ADR-032): the navigation of the triage and the To do card helpers. */

const user = (role: "admin" | "operator") => ({ role }) as SessionUser;
const hrefs = (u: SessionUser | null, demo: boolean) => navFor(u, demo).map((i) => i.href);

describe("navigation", () => {
  it("the phone's bottom bar: Home · To do · Conversations · Catalog, for everyone", () => {
    for (const u of [user("operator"), user("admin")]) {
      for (const demo of [false, true]) {
        expect(
          navFor(u, demo)
            .filter((i) => i.primary)
            .map((i) => i.href),
        ).toEqual(["/", "/todo", "/conversations", "/catalog"]);
      }
    }
  });

  it("More: Activity, Rules; Users for admins; System status for admins and the demo; Try in the demo", () => {
    expect(hrefs(user("operator"), false)).toEqual([
      "/",
      "/todo",
      "/conversations",
      "/catalog",
      "/activity",
      "/rules",
    ]);
    expect(hrefs(user("operator"), true)).toEqual([
      "/",
      "/todo",
      "/conversations",
      "/catalog",
      "/activity",
      "/rules",
      "/system",
      "/try",
    ]);
    expect(hrefs(user("admin"), false)).toEqual([
      "/",
      "/todo",
      "/conversations",
      "/catalog",
      "/activity",
      "/rules",
      "/users",
      "/system",
    ]);
    expect(hrefs(null, false)).not.toContain("/system");
  });

  it("System status: admins, and everyone in the public demo (read-only for the operator)", () => {
    expect(canSeeSystem(user("admin"), false)).toBe(true);
    expect(canSeeSystem(user("operator"), false)).toBe(false);
    expect(canSeeSystem(user("operator"), true)).toBe(true);
    expect(canSeeSystem(null, false)).toBe(false);
  });

  it("a review's page belongs to To do; the old lists are gone from the menu", () => {
    expect(isActive("/reviews/abc", "/todo")).toBe(true);
    expect(isActive("/todo/resolved", "/todo")).toBe(true);
    expect(isActive("/todo", "/")).toBe(false);
    expect(hrefs(user("admin"), true)).not.toContain("/reviews");
    expect(hrefs(user("admin"), true)).not.toContain("/alerts");
  });
});

describe("To do cards", () => {
  const msg = (type: string, mimeType?: string) => ({
    type,
    media: mimeType ? { filename: null, mimeType } : null,
  });

  it("names the kind of message a list came from", () => {
    expect(sourceKind(msg("audio", "audio/ogg"))).toBe("audio");
    expect(sourceKind(msg("image", "image/jpeg"))).toBe("image");
    expect(
      sourceKind(
        msg("document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
      ),
    ).toBe("spreadsheet");
    expect(sourceKind(msg("document", "text/csv"))).toBe("spreadsheet");
    expect(sourceKind(msg("document", "application/pdf"))).toBe("document");
    expect(sourceKind(msg("text"))).toBe("text");
  });

  it("orders a list like the API: run gate first, then creation order, then id", () => {
    const item = (id: string, scope: "run" | "line" | "catalog", createdAt: string) => ({
      id,
      scope,
      createdAt,
    });
    const items = [
      item("c", "catalog", "2026-10-01T00:00:00.000Z"),
      item("b", "line", "2026-10-01T00:00:02.000Z"),
      item("a", "line", "2026-10-01T00:00:01.000Z"),
      item("z", "run", "2026-10-01T00:00:09.000Z"),
      item("a2", "line", "2026-10-01T00:00:01.000Z"),
    ];
    expect(listOrder(items).map((i) => i.id)).toEqual(["z", "a", "a2", "b", "c"]);
  });
});
