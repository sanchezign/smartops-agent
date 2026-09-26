import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient, type Session } from "../src/lib/api-client";

/** Panel API client (phase 8): single-flight refresh, race retry, CSRF header, sign-out. */

const session = (token: string): Session => ({
  accessToken: token,
  expiresIn: 900,
  user: { id: "u", email: "a@x.uy", name: "Ana", role: "admin" },
});
const json = (status: number, body: unknown) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const apiError = (status: number, code: string) =>
  json(status, { error: { code, message: code, requestId: "r" } });

function setup(routes: (url: string, init: RequestInit) => Response | Promise<Response>) {
  let token: string | null = "old";
  const onSession = vi.fn((s: Session) => {
    token = s.accessToken;
  });
  const onSignedOut = vi.fn(() => {
    token = null;
  });
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    routes(String(input), init ?? {}),
  );
  const client = createApiClient({
    base: "/api/v1",
    fetch: fetchMock as unknown as typeof fetch,
    getAccessToken: () => token,
    onSession,
    onSignedOut,
    sleep: async () => {},
  });
  return { client, fetchMock, onSession, onSignedOut, token: () => token };
}

describe("api client", () => {
  it("sends the Bearer token; on 401 refreshes once and retries with the new token", async () => {
    const seen: (string | undefined)[] = [];
    const { client, fetchMock } = setup((url, init) => {
      if (url.endsWith("/auth/refresh")) return json(200, session("new"));
      const auth = (init.headers as Record<string, string>).authorization;
      seen.push(auth);
      return auth === "Bearer new" ? json(200, { ok: true }) : apiError(401, "UNAUTHORIZED");
    });
    expect(await client.request("/admin/settings")).toEqual({ ok: true });
    expect(seen).toEqual(["Bearer old", "Bearer new"]);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/auth/refresh"))).toHaveLength(
      1,
    );
  });

  it("media downloads use the same Bearer + refresh and return a Blob (ADR-019)", async () => {
    const seen: (string | undefined)[] = [];
    const { client } = setup((url, init) => {
      if (url.endsWith("/auth/refresh")) return json(200, session("new"));
      const auth = (init.headers as Record<string, string>).authorization;
      seen.push(auth);
      return auth === "Bearer new"
        ? new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } })
        : apiError(401, "UNAUTHORIZED");
    });
    const blob = await client.requestBlob("/admin/media/m1");
    expect(blob.type).toBe("image/jpeg");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(seen).toEqual(["Bearer old", "Bearer new"]);
  });

  it("a media 404 surfaces as an ApiError (no blob of an error page)", async () => {
    const { client } = setup(() => apiError(404, "NOT_FOUND"));
    await expect(client.requestBlob("/admin/media/m1")).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });

  it("concurrent 401s share ONE refresh (a rotated cookie must never be sent twice)", async () => {
    let refreshes = 0;
    const { client } = setup(async (url, init) => {
      if (url.endsWith("/auth/refresh")) {
        refreshes += 1;
        await new Promise((r) => setTimeout(r, 5));
        return json(200, session("new"));
      }
      const auth = (init.headers as Record<string, string>).authorization;
      return auth === "Bearer new" ? json(200, {}) : apiError(401, "UNAUTHORIZED");
    });
    await Promise.all([client.request("/a"), client.request("/b"), client.request("/c")]);
    expect(refreshes).toBe(1);
  });

  it("the refresh sends the CSRF header and the cookie (same-origin credentials)", async () => {
    const { client, fetchMock } = setup(() => json(200, session("new")));
    await client.refresh();
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      headers: expect.objectContaining({ "x-smartops-csrf": "1" }),
    });
  });

  it("REFRESH_RACE (another tab rotated first) is retried once", async () => {
    let calls = 0;
    const { client, onSession } = setup(() => {
      calls += 1;
      return calls === 1 ? apiError(409, "REFRESH_RACE") : json(200, session("new"));
    });
    expect(await client.refresh()).toBe(true);
    expect(onSession).toHaveBeenCalledOnce();
  });

  it("a dead session signs out and the original 401 surfaces", async () => {
    const { client, onSignedOut } = setup((url) =>
      url.endsWith("/auth/refresh") ? apiError(401, "UNAUTHORIZED") : apiError(401, "UNAUTHORIZED"),
    );
    await expect(client.request("/admin/users")).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
    });
    expect(onSignedOut).toHaveBeenCalledOnce();
  });

  it("a 403 is not a session problem: no refresh, the error is thrown as is", async () => {
    const { client, fetchMock } = setup(() => apiError(403, "FORBIDDEN"));
    const err = await client.request("/admin/users").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("FORBIDDEN");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("login stores the session; a failed login keeps the API error code", async () => {
    const ok = setup(() => json(200, session("fresh")));
    await ok.client.login("a@x.uy", "pw");
    expect(ok.token()).toBe("fresh");
    const bad = setup(() => apiError(401, "UNAUTHORIZED"));
    await expect(bad.client.login("a@x.uy", "pw")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("refreshes run inside the cross-tab lock when available", async () => {
    const locks = { request: vi.fn(async (_name: string, cb: () => Promise<unknown>) => cb()) };
    const client = createApiClient({
      base: "/api/v1",
      fetch: (async () => json(200, session("new"))) as unknown as typeof fetch,
      getAccessToken: () => null,
      onSession: () => {},
      onSignedOut: () => {},
      locks: locks as never,
    });
    await client.refresh();
    expect(locks.request).toHaveBeenCalledWith("smartops-auth-refresh", expect.any(Function));
  });
});
