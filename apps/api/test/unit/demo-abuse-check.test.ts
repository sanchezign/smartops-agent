import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * scripts/deploy/demo-abuse-check.mjs against a local fake of the demo API. The fake enforces the real
 * limits (global per-IP window, login limit, event-stream cap, sample cap) in the `strict` mode and
 * enforces none, or the wrong thing, in the other modes: the script must pass the first and report
 * every weakness of the others (a check that cannot fail proves nothing).
 */
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SCRIPT = `${ROOT}scripts/deploy/demo-abuse-check.mjs`;

type Mode = "strict" | "no-limits" | "spoofable";
const WINDOW_MS = 3000;

function fakeApi(mode: Mode): Promise<{ server: Server; url: string }> {
  let windowStart = Date.now();
  let hits = 0;
  let logins = 0;
  let injects = 0;
  const loginByForwarded = new Map<string, number>();
  let streams = 0;
  const operator = { email: "demo@example.test", password: "public-demo-password" };
  const json = (
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const err = (
    res: ServerResponse,
    status: number,
    code: string,
    headers: Record<string, string> = {},
  ) => json(res, status, { error: { code, message: code } }, headers);

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "").replace(/^\/api\/v1/, "");
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size <= 4096) chunks.push(chunk as Buffer);
    }
    if (path === "/health") return json(res, 200, { status: "ok" });

    if (Date.now() - windowStart > WINDOW_MS) {
      windowStart = Date.now();
      hits = 0;
    }
    hits += 1;
    if (mode !== "no-limits" && hits > 300) {
      const wait = Math.max(1, Math.ceil((windowStart + WINDOW_MS - Date.now()) / 1000));
      return err(res, 429, "RATE_LIMITED", { "retry-after": String(wait) });
    }
    const authed = (req.headers.authorization ?? "").startsWith("Bearer ");
    if (path === "/internal/rules" || path.startsWith("/webhooks/"))
      return err(res, 404, "NOT_FOUND");
    if (path === "/demo/info") return json(res, 200, { operator });
    if (path === "/auth/login") {
      if (size > 1024 * 1024 && mode !== "no-limits") return err(res, 413, "PAYLOAD_TOO_LARGE");
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { email?: string };
      if (body.email === operator.email) return json(res, 200, { accessToken: "token" });
      const key = mode === "spoofable" ? String(req.headers["x-forwarded-for"]) : "ip";
      const n = (loginByForwarded.get(key) ?? 0) + 1;
      loginByForwarded.set(key, n);
      logins += 1;
      if (mode !== "no-limits" && n > 10)
        return err(res, 429, "RATE_LIMITED", { "retry-after": "900" });
      return err(res, 401, "INVALID_CREDENTIALS");
    }
    if (!authed) return err(res, 401, "UNAUTHORIZED");
    if (path === "/events") {
      if (mode !== "no-limits" && streams >= 5) return err(res, 429, "TOO_MANY_STREAMS");
      streams += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: ready\ndata: {}\n\n");
      res.on("close", () => (streams -= 1));
      return;
    }
    if (path === "/auth/logout-all")
      return mode === "no-limits" ? json(res, 204, {}) : err(res, 403, "FORBIDDEN");
    if (path === "/demo/inject") {
      injects += 1;
      if (mode !== "no-limits" && injects > 20)
        return err(res, 429, "RATE_LIMITED", { "retry-after": "600" });
      return json(res, 202, { wamid: `wamid.${injects}` });
    }
    if (path.startsWith("/demo/trace/")) return json(res, 200, { run: { status: "needs_review" } });
    return err(res, 404, "NOT_FOUND");
  };
  void logins;
  return new Promise((resolve) => {
    const server = createServer((req, res) => void handler(req, res));
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }),
    );
  });
}

function runScript(url: string, extra: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, url, ...extra], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}

let open: Server | null = null;
afterEach(() => {
  open?.closeAllConnections();
  open?.close();
  open = null;
});
const start = async (mode: Mode) => {
  const { server, url } = await fakeApi(mode);
  open = server;
  return url;
};

describe("demo-abuse-check.mjs", () => {
  it("passes against a server that enforces every limit", async () => {
    const r = await runScript(await start("strict"), ["--inject-burst"]);
    expect(r.out).toContain("ABUSE CHECK PASSED");
    expect(r.out).toContain("the spoofed header did not dodge it");
    expect(r.out).toMatch(/the cap answered 429 after 20 accepted samples/);
    expect(r.code).toBe(0);
  }, 60_000);

  it("reports every missing limit on a server that has none", async () => {
    const r = await runScript(await start("no-limits"), ["--inject-burst"]);
    expect(r.out).toContain("ABUSE CHECK FAILED");
    for (const weakness of [
      "2 MB body to /auth/login",
      "event streams: first 5 open",
      "logout-all with the shared account",
      "a 429 RATE_LIMITED arrived",
      "login answered 429",
      "the cap answered",
    ]) {
      expect(r.out).toMatch(new RegExp(`FAIL ${weakness.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    }
    expect(r.code).toBe(1);
  }, 90_000);

  it("catches a login limit that a spoofed X-Forwarded-For dodges", async () => {
    const r = await runScript(await start("spoofable"), []);
    expect(r.out).toMatch(/FAIL login answered 429/);
    expect(r.code).toBe(1);
  }, 60_000);

  it("--skip-login-limit leaves the login limit alone", async () => {
    const r = await runScript(await start("strict"), ["--skip-login-limit"]);
    expect(r.out).toContain("login limit: skipped");
    expect(r.out).not.toContain("spoofed header");
    expect(r.code).toBe(0);
  }, 60_000);

  it("refuses plain http to a remote host and a missing argument", async () => {
    for (const bad of ["http://example.com", ""]) {
      const r = await runScript(bad, []);
      expect(r.code).toBe(2);
      expect(r.out).toContain("usage:");
    }
  });
});
