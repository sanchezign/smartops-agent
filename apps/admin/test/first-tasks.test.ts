import { describe, expect, it } from "vitest";
import { firstTasks } from "../src/features/dashboard/first-tasks";
import type { TodoView } from "../src/features/todo/types";

/** The Home's first decisions (phase 15 M5). */

const review = (id: string, at: string) => ({ id, message: { receivedAt: at } });
const group = (items: ReturnType<typeof review>[], waiting: ReturnType<typeof review>[] = []) => ({
  items,
  waitingItems: waiting,
});

describe("firstTasks", () => {
  it("the 3 newest of the user's reviews and messages; never the admin-only ones", () => {
    const todo = {
      groups: [
        group(
          [review("r1", "2026-10-12T10:00:00Z"), review("r2", "2026-10-12T10:00:00Z")],
          [review("admin", "2026-10-12T11:00:00Z")],
        ),
        group([review("r3", "2026-10-09T10:00:00Z")]),
      ],
      alerts: [{ id: "a1", createdAt: "2026-10-11T10:00:00Z" }],
    } as unknown as Pick<TodoView, "groups" | "alerts">;
    expect(firstTasks(todo).map((t) => (t.kind === "review" ? t.item.id : t.alert.id))).toEqual([
      "r1",
      "r2",
      "a1",
    ]);
  });

  it("nothing → nothing", () => {
    expect(firstTasks({ groups: [], alerts: [] })).toEqual([]);
  });
});
