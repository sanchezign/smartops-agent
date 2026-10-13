import type { ReviewItem } from "@/features/reviews/types";
import type { TodoAlert, TodoView } from "@/features/todo/types";

/**
 * The decisions the Home shows (phase 15 M5): the newest ones THIS user can take — reviews of the
 * To do cards above (never the admin-only ones) and the messages to check — newest first. The rest
 * is one "See all" away. Pure — unit tested.
 */

export const HOME_TASKS = 3;

export type Task =
  | { kind: "review"; at: string; item: ReviewItem }
  | { kind: "alert"; at: string; alert: TodoAlert };

export function firstTasks(todo: Pick<TodoView, "groups" | "alerts">, limit = HOME_TASKS): Task[] {
  const reviews: Task[] = todo.groups.flatMap((g) =>
    g.items.map((item) => ({ kind: "review" as const, at: item.message.receivedAt, item })),
  );
  const alerts: Task[] = todo.alerts.map((alert) => ({
    kind: "alert" as const,
    at: alert.createdAt,
    alert,
  }));
  return [...reviews, ...alerts].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}
