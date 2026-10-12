import { describe, expect, it } from "vitest";
import { ReviewKind, ReviewScope } from "../../src/generated/prisma/enums.js";
import { canResolveReview } from "../../src/modules/auth/permissions.js";
import {
  splitPending,
  todoCounts,
  type PendingKindCount,
  type Viewer,
} from "../../src/modules/admin/todo-rules.js";

/** To do counters (phase 15, ADR-032): split by the SAME rule the approve route uses. */

const ADMIN: Viewer = { role: "admin", demoMode: false };
const OPERATOR: Viewer = { role: "operator", demoMode: false };
const DEMO_OPERATOR: Viewer = { role: "operator", demoMode: true };

const groups: PendingKindCount[] = [
  { scope: "run", kind: "column_mapping", count: 1 },
  { scope: "run", kind: "unknown_supplier", count: 2 },
  { scope: "line", kind: "price_outlier", count: 4 },
  { scope: "line", kind: "product_match", count: 3 },
  { scope: "catalog", kind: "mark_unavailable", count: 5 },
];

describe("splitPending", () => {
  it("admin resolves everything", () => {
    expect(splitPending(groups, ADMIN)).toEqual({ canResolve: 15, waitingForAdmin: 0 });
  });

  it("an operator resolves lines; gates and catalog-wide items wait for an admin", () => {
    expect(splitPending(groups, OPERATOR)).toEqual({ canResolve: 7, waitingForAdmin: 8 });
  });

  it("in DEMO_MODE the operator also resolves column_mapping (ADR-030), nothing else", () => {
    expect(splitPending(groups, DEMO_OPERATOR)).toEqual({ canResolve: 8, waitingForAdmin: 7 });
  });

  it("agrees with canResolveReview for every scope × kind × viewer, one item at a time", () => {
    const viewers: Viewer[] = [ADMIN, OPERATOR, DEMO_OPERATOR, { role: "admin", demoMode: true }];
    for (const viewer of viewers) {
      for (const scope of Object.values(ReviewScope)) {
        for (const kind of Object.values(ReviewKind)) {
          const mine = canResolveReview(viewer.role, { scope, kind }, viewer);
          expect(splitPending([{ scope, kind, count: 1 }], viewer)).toEqual({
            canResolve: mine ? 1 : 0,
            waitingForAdmin: mine ? 0 : 1,
          });
        }
      }
    }
  });

  it("nothing pending → zeros", () => {
    expect(splitPending([], OPERATOR)).toEqual({ canResolve: 0, waitingForAdmin: 0 });
  });
});

describe("todoCounts", () => {
  it("the yellow total is what the user can resolve plus the action alerts", () => {
    expect(todoCounts({ canResolve: 7, waitingForAdmin: 8 }, 2)).toEqual({
      total: 9,
      reviews: { canResolve: 7, waitingForAdmin: 8 },
      alerts: 2,
    });
  });
});
