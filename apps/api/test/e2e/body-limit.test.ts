import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { buildTestApp } from "../helpers/build-app.js";

/**
 * An oversized JSON body is refused with 413 PAYLOAD_TOO_LARGE on the public entry points, over a
 * REAL socket (the 2 MB request is streamed, the answer comes before the body is read: supertest hides
 * that). Found by scripts/deploy/demo-abuse-check.mjs against the public demo, which got a 400.
 */
async function post(path: string, bytes: number, headers: Record<string, string> = {}) {
  const server = buildTestApp().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ x: "a".repeat(bytes) }),
    });
    return { status: res.status, json: (await res.json().catch(() => null)) as unknown };
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

describe("body size limit over a real socket", () => {
  it.each([
    "/api/v1/auth/login",
    "/api/v1/auth/refresh",
    "/api/v1/demo/inject",
    "/api/v1/anything",
  ])("%s answers 413 PAYLOAD_TOO_LARGE for a 2 MB body", async (path) => {
    const r = await post(path, 2 * 1024 * 1024, {
      "x-smartops-csrf": "1",
      origin: "http://localhost:3000",
    });
    expect(r.status).toBe(413);
    expect(r.json).toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });
  });

  it("still accepts a body under the limit (the login answers on its merits, not 413)", async () => {
    const r = await post("/api/v1/auth/login", 1000, {
      "x-smartops-csrf": "1",
      origin: "http://localhost:3000",
    });
    expect(r.status).not.toBe(413);
  });
});
