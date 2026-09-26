/**
 * Minimal Server-Sent Events parser for a fetch() stream (phase 9 M4, ADR-020). EventSource
 * cannot send the Bearer header, so the panel reads the stream itself. Handles frames split
 * across chunks, CRLF, comments (": ping"), multi-line data and the `retry` field.
 */

export interface SseFrame {
  event: string;
  data: string;
  id: string | null;
}

export function createSseParser(handlers: {
  onFrame(frame: SseFrame): void;
  onComment?(text: string): void;
  onRetry?(ms: number): void;
}) {
  let buffer = "";
  let event = "";
  let data: string[] = [];
  let id: string | null = null;

  function dispatch() {
    if (data.length > 0) handlers.onFrame({ event: event || "message", data: data.join("\n"), id });
    event = "";
    data = [];
  }

  function line(text: string) {
    if (text === "") return dispatch();
    if (text.startsWith(":")) return handlers.onComment?.(text.slice(1).trim());
    const colon = text.indexOf(":");
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
    else if (field === "retry" && /^\d+$/.test(value)) handlers.onRetry?.(Number(value));
  }

  return {
    push(chunk: string) {
      buffer += chunk;
      // A trailing "\r" may be half of a "\r\n" split across chunks: wait for the next one.
      const held = buffer.endsWith("\r");
      const complete = held ? buffer.slice(0, -1) : buffer;
      const lines = complete.split(/\r\n|\r|\n/);
      buffer = (lines.pop() ?? "") + (held ? "\r" : "");
      for (const l of lines) line(l);
    },
  };
}
