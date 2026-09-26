import type { PrismaClient } from "../../common/db.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { ReviewKind, ReviewScope, ReviewStatus } from "../../generated/prisma/enums.js";

/**
 * Read model of the review queue for the panel (phase 9 M2): each item with the context a
 * person needs to decide — supplier, current product, the message that caused it. Read-only;
 * decisions still go through ReviewService (ADR-012).
 */

export interface ReviewView {
  id: string;
  scope: ReviewScope;
  kind: ReviewKind;
  status: ReviewStatus;
  reasons: string[];
  proposal: unknown;
  resolution: unknown;
  resolvedAt: Date | null;
  createdAt: Date;
  supplier: { id: string; name: string } | null;
  product: { id: string; name: string; price: Prisma.Decimal; currency: string } | null;
  run: { id: string; status: string };
  message: {
    id: string;
    conversationId: string;
    type: string;
    text: string | null;
    transcript: string | null;
    receivedAt: Date;
    media: { filename: string | null; mimeType: string } | null;
  };
}

export interface ReviewQueryFilter {
  status?: ReviewStatus;
  kind?: ReviewKind;
  scope?: ReviewScope;
  supplierId?: string;
  limit?: number;
}

const select = {
  id: true,
  scope: true,
  kind: true,
  status: true,
  reasons: true,
  proposal: true,
  resolution: true,
  resolvedAt: true,
  createdAt: true,
  supplier: { select: { id: true, name: true } },
  product: { select: { id: true, name: true, price: true, currency: true } },
  ingestionRun: {
    select: {
      id: true,
      status: true,
      message: {
        select: {
          id: true,
          conversationId: true,
          type: true,
          text: true,
          transcript: true,
          waTimestamp: true,
          createdAt: true,
          mediaFile: { select: { filename: true, mimeType: true } },
        },
      },
    },
  },
} as const;

type Row = Prisma.ReviewItemGetPayload<{ select: typeof select }>;

function toView(row: Row): ReviewView {
  const m = row.ingestionRun.message;
  return {
    id: row.id,
    scope: row.scope,
    kind: row.kind,
    status: row.status,
    reasons: row.reasons,
    proposal: row.proposal,
    resolution: row.resolution,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
    supplier: row.supplier,
    product: row.product,
    run: { id: row.ingestionRun.id, status: row.ingestionRun.status },
    message: {
      id: m.id,
      conversationId: m.conversationId,
      type: m.type,
      text: m.text,
      transcript: m.transcript,
      receivedAt: m.waTimestamp ?? m.createdAt,
      media: m.mediaFile,
    },
  };
}

export function createReviewQueryRepository(prisma: PrismaClient) {
  return {
    async list(filter: ReviewQueryFilter): Promise<ReviewView[]> {
      const rows = await prisma.reviewItem.findMany({
        where: {
          status: filter.status ?? "pending",
          ...(filter.kind ? { kind: filter.kind } : {}),
          ...(filter.scope ? { scope: filter.scope } : {}),
          ...(filter.supplierId ? { supplierId: filter.supplierId } : {}),
        },
        select,
        // Run gates first (they block a whole list), then oldest first (FIFO).
        orderBy: [{ scope: "asc" }, { createdAt: "asc" }],
        take: filter.limit ?? 100,
      });
      return rows.map(toView);
    },

    async get(id: string): Promise<ReviewView | null> {
      const row = await prisma.reviewItem.findUnique({ where: { id }, select });
      return row ? toView(row) : null;
    },

    /** Pending items per scope (filter chips and the nav badge). */
    async summary(): Promise<{ total: number; byScope: Record<ReviewScope, number> }> {
      const groups = await prisma.reviewItem.groupBy({
        by: ["scope"],
        where: { status: "pending" },
        _count: { _all: true },
      });
      const byScope = { run: 0, line: 0, catalog: 0 } as Record<ReviewScope, number>;
      for (const g of groups) byScope[g.scope] = g._count._all;
      return { total: byScope.run + byScope.line + byScope.catalog, byScope };
    },

    async suppliers(): Promise<{ id: string; name: string }[]> {
      return prisma.supplier.findMany({
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      });
    },
  };
}
export type ReviewQueryRepository = ReturnType<typeof createReviewQueryRepository>;
