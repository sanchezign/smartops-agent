/**
 * Panel ↔ API client (phase 8, ADR-018).
 * - The access token lives only in memory (the auth store), sent as a Bearer header.
 * - On a 401 the client refreshes ONCE and retries. Refreshes are single-flight inside a tab
 *   and serialized across tabs with the Web Locks API, because the refresh cookie rotates on
 *   every use and a reused one ends the session. A 409 REFRESH_RACE (another tab just
 *   rotated it) is retried once with the new cookie.
 * - Cookie-authenticated calls (login, refresh, logout) send the CSRF header the API requires.
 */

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: "admin" | "operator";
}

export interface Session {
  accessToken: string;
  expiresIn: number;
  user: SessionUser;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    /** Correlates the failure with the API logs (shown to the person for support). */
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export interface ApiClientDeps {
  base: string;
  fetch: typeof fetch;
  getAccessToken(): string | null;
  onSession(session: Session): void;
  onSignedOut(): void;
  /** navigator.locks when available (all current browsers); tests inject a fake. */
  locks?: LockManagerLike;
  sleep?: (ms: number) => Promise<void>;
}

const CSRF = { "x-smartops-csrf": "1" };
const REFRESH_LOCK = "smartops-auth-refresh";

async function toError(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as {
    error?: { code?: string; message?: string; details?: unknown; requestId?: string };
  } | null;
  return new ApiError(
    res.status,
    body?.error?.code ?? "HTTP_ERROR",
    body?.error?.message ?? res.statusText,
    body?.error?.details,
    body?.error?.requestId ?? res.headers.get("x-request-id") ?? undefined,
  );
}

export function createApiClient(deps: ApiClientDeps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let inflight: Promise<boolean> | null = null;

  const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    deps.fetch(`${deps.base}${path}`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        ...CSRF,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  async function refreshOnce(): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await post("/auth/refresh");
      if (res.ok) {
        deps.onSession((await res.json()) as Session);
        return true;
      }
      const error = await toError(res);
      if (error.code === "REFRESH_RACE" && attempt === 0) {
        await sleep(250); // the other tab's new cookie is in place by now
        continue;
      }
      deps.onSignedOut();
      return false;
    }
    return false;
  }

  function refresh(): Promise<boolean> {
    inflight ??= (
      deps.locks ? deps.locks.request(REFRESH_LOCK, refreshOnce) : refreshOnce()
    ).finally(() => {
      inflight = null;
    });
    return inflight;
  }

  /** Authenticated call: Bearer from memory, ONE refresh + retry on a 401. */
  async function send(path: string, init: RequestInit = {}, retried = false): Promise<Response> {
    const token = deps.getAccessToken();
    const res = await deps.fetch(`${deps.base}${path}`, {
      ...init,
      credentials: "same-origin",
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers as Record<string, string> | undefined),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    if (res.status === 401 && !retried && (await refresh())) return send(path, init, true);
    if (!res.ok) throw await toError(res);
    return res;
  }

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await send(path, init);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  /**
   * Binary download with the same auth (ADR-019): chat media is never fetched through a URL
   * that carries credentials; the caller shows it from a blob: URL.
   */
  async function requestBlob(path: string, init: RequestInit = {}): Promise<Blob> {
    return (await send(path, init)).blob();
  }

  return {
    request,
    requestBlob,
    /** Raw authenticated response for streams (SSE, ADR-020): same Bearer + refresh rules. */
    stream: (path: string, init: RequestInit = {}) => send(path, init),
    refresh,
    async login(email: string, password: string): Promise<Session> {
      const res = await post("/auth/login", { email, password });
      if (!res.ok) throw await toError(res);
      const session = (await res.json()) as Session;
      deps.onSession(session);
      return session;
    },
    async logout(): Promise<void> {
      await post("/auth/logout").catch(() => undefined);
      deps.onSignedOut();
    },
    async logoutAll(): Promise<number> {
      const { sessions } = await request<{ sessions: number }>("/auth/logout-all", {
        method: "POST",
      });
      deps.onSignedOut();
      return sessions;
    },
  };
}
export type ApiClient = ReturnType<typeof createApiClient>;
