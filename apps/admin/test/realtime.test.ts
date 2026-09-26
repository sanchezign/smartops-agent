import { describe, expect, it } from "vitest";
import { backoffMs, keysFor, mergeKeys } from "../src/features/realtime/invalidation";
import { createSseParser, type SseFrame } from "../src/lib/sse";

/** Panel real time (phase 9 M4, ADR-020): SSE parsing over fetch + query invalidation. */

function parse(chunks: string[]) {
  const frames: SseFrame[] = [];
  const comments: string[] = [];
  const retries: number[] = [];
  const parser = createSseParser({
    onFrame: (f) => frames.push(f),
    onComment: (c) => comments.push(c),
    onRetry: (ms) => retries.push(ms),
  });
  for (const c of chunks) parser.push(c);
  return { frames, comments, retries };
}

describe("createSseParser", () => {
  it("frames split anywhere across chunks, CRLF, comments and retry", () => {
    const { frames, comments, retries } = parse([
      "retry: 5000\n\nid: 1\nev",
      'ent: ready\ndata: {"heartbeatMs":25000}\r\n\r\n: ping\n\n',
      "id: 2\nevent: events\ndata: [1,\ndata: 2]\n",
      "\n",
    ]);
    expect(retries).toEqual([5000]);
    expect(comments).toEqual(["ping"]);
    expect(frames).toEqual([
      { event: "ready", data: '{"heartbeatMs":25000}', id: "1" },
      { event: "events", data: "[1,\n2]", id: "2" },
    ]);
  });

  it("a CRLF split between chunks is one line break, not an early dispatch", () => {
    expect(parse(["event: events\r", "\ndata: a\r", "\ndata: b\r\n\r\n"]).frames).toEqual([
      { event: "events", data: "a\nb", id: null },
    ]);
  });

  it("an incomplete frame waits for its blank line; no data = nothing dispatched", () => {
    expect(parse(["event: events\ndata: x"]).frames).toEqual([]);
    expect(parse(["event: lonely\n\n"]).frames).toEqual([]);
  });
});

describe("keysFor / mergeKeys", () => {
  const C = "c1";
  it("a new message refreshes that chat, the inbox, its header (24 h window) and the dashboard", () => {
    expect(
      keysFor({ type: "message.created", conversationId: C, messageId: "m", direction: "inbound" }),
    ).toEqual([
      ["conversations", "messages", C],
      ["conversations", "inbox"],
      ["conversations", "header", C],
      ["dashboard"],
    ]);
  });

  it("broader prefixes absorb narrower ones and duplicates collapse", () => {
    const keys = [
      ...keysFor({ type: "conversation.updated", conversationId: C, mode: "human" }),
      ...keysFor({ type: "contact.updated", contactId: "k" }),
      ...keysFor({ type: "review.changed", reviewId: "r", status: "pending" }),
      ...keysFor({ type: "review.changed", reviewId: "r2", status: "approved" }),
    ];
    expect(mergeKeys(keys)).toEqual([["conversations"], ["contacts"], ["reviews"], ["dashboard"]]);
  });
});

describe("backoffMs", () => {
  it("1 s doubling to 30 s with ±20 % jitter", () => {
    expect(backoffMs(0, () => 0.5)).toBe(1000);
    expect(backoffMs(3, () => 0.5)).toBe(8000);
    expect(backoffMs(10, () => 0.5)).toBe(30000);
    expect(backoffMs(0, () => 0)).toBe(800);
    expect(backoffMs(0, () => 1)).toBe(1200);
  });
});
