import type { PrismaClient } from "../../common/db.js";
import { Prisma } from "../../generated/prisma/client.js";
import type { AlertSeverity, AlertType } from "../../generated/prisma/enums.js";
import { alertTypesIn } from "./alert-category.js";
import { alertDetails } from "./alert-details.js";
import { OPEN_ALERT_STATUSES } from "./catalog-query.repository.js";
import type { ReviewQueryRepository, ReviewView } from "./review-query.repository.js";
import {
  resolvablePairs,
  splitPending,
  todoCounts,
  TODO_ALERT_LIMIT,
  TODO_GROUP_LIMIT,
  TODO_ITEMS_PER_GROUP,
  type PendingKindCount,
  type ReviewSplit,
  type TodoCounts,
  type Viewer,
} from "./todo-rules.js";

/**
 * To do read model (phase 15, ADR-032): what waits for a person = pending review items, grouped
 * by list (one ingestion run = one message), + open ACTION alerts. Read-only; decisions still go
 * through ReviewService and the alert acknowledge route.
 *
 * A fixed number of SQL statements whatever the amount of data (no N+1; measured by
 * test/integration/todo-query.test.ts):
 * - summary(): 2 — pending reviews grouped by (scope, kind), the action alerts count.
 * - todo():    13 — summary's 2, the newest lists with their first items (one SQL statement),
 *              pending counts per (list, scope, kind), the item views (6: Prisma 7 reads each
 *              nested relation with ONE `IN (...)` statement) and the action alerts with their
 *              message and conversation (3).
 * The counters and the lists are separate reads (no transaction): a review resolved in between
 * can make them differ by one until the next refresh (SSE invalidates both).
 */

const ACTION_ALERT_TYPES = alertTypesIn("action");

export interface TodoGroup {
  run: { id: string; status: string };
  supplier: { id: string; name: string } | null;
  message: ReviewView["message"];
  /** Pending items of this list, all of them. */
  pending: number;
  reviews: ReviewSplit;
  /**
   * The first TODO_ITEMS_PER_GROUP items THIS viewer may resolve (run gate first, then the list's
   * order). Each item is in exactly one of `items` / `waitingItems` (owner, phase 15 M2 review).
   */
  items: ReviewView[];
  /** The first TODO_ITEMS_PER_GROUP items only an admin may resolve (always empty for an admin). */
  waitingItems: ReviewView[];
}

export interface TodoAlert {
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  status: string;
  title: string;
  /** Whitelisted payload fields, so the panel writes the alert in its language (phase 13). */
  details: Record<string, string | number | null> | null;
  createdAt: Date;
  /** The chat it refers to (voice note to listen to, ambiguous opt-out phrase). */
  conversationId: string | null;
  /** The contact (to opt them out from the panel, possible_opt_out). */
  contactId: string | null;
}

export interface TodoView {
  counts: TodoCounts;
  groups: TodoGroup[];
  /** More lists wait than the TODO_GROUP_LIMIT returned. */
  groupsTruncated: boolean;
  alerts: TodoAlert[];
}

const pendingReviews = { status: "pending" } as const;
const openActionAlerts = {
  status: { in: OPEN_ALERT_STATUSES },
  type: { in: ACTION_ALERT_TYPES },
} satisfies Prisma.AlertWhereInput;

const payloadString = (payload: unknown, key: string): string | null => {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === "string" ? v : null;
};

export function createTodoQueryRepository(
  prisma: PrismaClient,
  deps: { reviewQuery: Pick<ReviewQueryRepository, "byIds"> },
) {
  async function summary(viewer: Viewer): Promise<TodoCounts> {
    const [byKind, alerts] = await Promise.all([
      prisma.reviewItem.groupBy({
        by: ["scope", "kind"],
        where: pendingReviews,
        _count: { _all: true },
      }),
      prisma.alert.count({ where: openActionAlerts }),
    ]);
    const groups: PendingKindCount[] = byKind.map((g) => ({
      scope: g.scope,
      kind: g.kind,
      count: g._count._all,
    }));
    return todoCounts(splitPending(groups, viewer), alerts);
  }

  /**
   * The newest lists with pending items (newest message first, like the review list: a null
   * waTimestamp sorts last), each with its first items (scope run → line → catalog, then the
   * order they were created in, i.e. the list's own order) — the first ones the viewer may
   * resolve AND the first ones only an admin may resolve, ranked separately. "Mine" is the
   * (scope, kind) list of `resolvablePairs` (canResolveReview), never a rule restated in SQL.
   * One statement; LIMIT + 1 tells whether more lists exist.
   */
  async function topLists(viewer: Viewer) {
    const pairs = resolvablePairs(viewer);
    const mine = pairs.length
      ? Prisma.sql`(r.scope::text, r.kind::text) IN (${Prisma.join(
          pairs.map((p) => Prisma.sql`(${p.scope}, ${p.kind})`),
        )})`
      : Prisma.sql`FALSE`;
    return prisma.$queryRaw<{ run_id: string; review_id: string; mine: boolean }[]>`
      WITH runs AS (
        SELECT r.ingestion_run_id AS run_id,
               ROW_NUMBER() OVER (
                 ORDER BY m.wa_timestamp DESC NULLS LAST, m.created_at DESC, r.ingestion_run_id
               ) AS rank
        FROM review_items r
        JOIN ingestion_runs ir ON ir.id = r.ingestion_run_id
        JOIN messages m ON m.id = ir.message_id
        WHERE r.status = 'pending'
        GROUP BY r.ingestion_run_id, m.wa_timestamp, m.created_at
        ORDER BY rank
        LIMIT ${TODO_GROUP_LIMIT + 1}
      ),
      ranked AS (
        SELECT r.id, r.ingestion_run_id AS run_id, ${mine} AS mine,
               ROW_NUMBER() OVER (
                 PARTITION BY r.ingestion_run_id, ${mine} ORDER BY r.scope, r.created_at, r.id
               ) AS n
        FROM review_items r
        WHERE r.status = 'pending' AND r.ingestion_run_id IN (SELECT run_id FROM runs)
      )
      SELECT runs.run_id::text AS run_id, ranked.id::text AS review_id, ranked.mine
      FROM runs JOIN ranked ON ranked.run_id = runs.run_id
      WHERE ranked.n <= ${TODO_ITEMS_PER_GROUP}
      ORDER BY runs.rank, ranked.mine DESC, ranked.n`;
  }

  async function actionAlerts(): Promise<TodoAlert[]> {
    const rows = await prisma.alert.findMany({
      where: openActionAlerts,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: TODO_ALERT_LIMIT,
      select: {
        id: true,
        type: true,
        severity: true,
        status: true,
        title: true,
        payload: true,
        createdAt: true,
      },
    });
    // Action alerts carry the message they refer to in their payload (no ingestion run).
    const messageIds = [
      ...new Set(rows.flatMap((a) => payloadString(a.payload, "messageId") ?? [])),
    ];
    const messages = messageIds.length
      ? await prisma.message.findMany({
          where: { id: { in: messageIds } },
          select: { id: true, conversationId: true, conversation: { select: { contactId: true } } },
        })
      : [];
    const byMessage = new Map(messages.map((m) => [m.id, m]));
    return rows.map(({ payload, ...a }) => {
      const message = byMessage.get(payloadString(payload, "messageId") ?? "");
      return {
        ...a,
        details: alertDetails(a.type, payload),
        conversationId: message?.conversationId ?? null,
        contactId: message?.conversation.contactId ?? payloadString(payload, "contactId"),
      };
    });
  }

  return {
    summary,

    async todo(viewer: Viewer): Promise<TodoView> {
      const [counts, listRows, alerts] = await Promise.all([
        summary(viewer),
        topLists(viewer),
        actionAlerts(),
      ]);
      const runIds = [...new Set(listRows.map((r) => r.run_id))];
      const groupsTruncated = runIds.length > TODO_GROUP_LIMIT;
      const shownRuns = runIds.slice(0, TODO_GROUP_LIMIT);
      const shown = new Set(shownRuns);
      const shownRows = listRows.filter((r) => shown.has(r.run_id));
      const reviewIds = shownRows.map((r) => r.review_id);
      const isMine = new Map(shownRows.map((r) => [r.review_id, r.mine]));

      const [perList, items] = await Promise.all([
        shownRuns.length
          ? prisma.reviewItem.groupBy({
              by: ["ingestionRunId", "scope", "kind"],
              where: { ...pendingReviews, ingestionRunId: { in: shownRuns } },
              _count: { _all: true },
            })
          : Promise.resolve([]),
        deps.reviewQuery.byIds(reviewIds),
      ]);

      const kindsOf = new Map<string, PendingKindCount[]>();
      for (const g of perList) {
        const list = kindsOf.get(g.ingestionRunId) ?? [];
        list.push({ scope: g.scope, kind: g.kind, count: g._count._all });
        kindsOf.set(g.ingestionRunId, list);
      }
      const itemsOf = new Map<string, ReviewView[]>();
      for (const item of items) {
        itemsOf.set(item.run.id, [...(itemsOf.get(item.run.id) ?? []), item]);
      }
      const byOwner = (list: ReviewView[], mine: boolean) =>
        list.filter((i) => (isMine.get(i.id) ?? false) === mine);

      const groups = shownRuns.flatMap((runId): TodoGroup[] => {
        const listItems = itemsOf.get(runId) ?? [];
        const first = listItems[0];
        if (!first) return []; // resolved between the two reads
        const kinds = kindsOf.get(runId) ?? [];
        return [
          {
            run: first.run,
            supplier: listItems.find((i) => i.supplier)?.supplier ?? null,
            message: first.message,
            pending: kinds.reduce((n, k) => n + k.count, 0),
            reviews: splitPending(kinds, viewer),
            items: byOwner(listItems, true),
            waitingItems: byOwner(listItems, false),
          },
        ];
      });
      return { counts, groups, groupsTruncated, alerts };
    },
  };
}
export type TodoQueryRepository = ReturnType<typeof createTodoQueryRepository>;
