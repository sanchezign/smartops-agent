import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createErrorHandler } from "../../src/common/errors/error-handler.js";
import {
  createCsrfGuard,
  readCookie,
  refreshCookieConfig,
} from "../../src/modules/auth/auth-http.js";
import { decideRefresh, nextIdleExpiry } from "../../src/modules/auth/session-rules.js";
import {
  createAccessTokens,
  hashRefreshToken,
  newRefreshToken,
} from "../../src/modules/auth/tokens.js";

const NOW = new Date("2026-09-27T12:00:00Z");
const sec = (s: number) => new Date(NOW.getTime() + s * 1000);
const liveSession = {
  revokedAt: null,
  idleExpiresAt: sec(3600),
  expiresAt: sec(86_400),
  userActive: true,
};

describe("refresh rotation decision (RFC 9700 reuse detection)", () => {
  it("a current token rotates", () => {
    expect(decideRefresh({ rotatedAt: null, isLatestRotated: false }, liveSession, NOW)).toEqual({
      action: "rotate",
    });
  });

  it("the token rotated just now (≤ 10 s, latest) is a tab race: retry, nothing revoked", () => {
    expect(decideRefresh({ rotatedAt: sec(-3), isLatestRotated: true }, liveSession, NOW)).toEqual({
      action: "race",
    });
  });

  it.each([
    ["rotated 11 s ago", { rotatedAt: sec(-11), isLatestRotated: true }],
    ["an older rotated token, even within 10 s", { rotatedAt: sec(-2), isLatestRotated: false }],
  ])("%s → reuse: revoke the whole session", (_label, token) => {
    expect(decideRefresh(token, liveSession, NOW)).toEqual({ action: "revoke_reuse" });
  });

  it.each([
    ["revoked", { ...liveSession, revokedAt: sec(-60) }, "revoked"],
    ["user inactive", { ...liveSession, userActive: false }, "user_inactive"],
    ["absolute expiry", { ...liveSession, expiresAt: sec(-1) }, "expired"],
    ["idle expiry", { ...liveSession, idleExpiresAt: sec(0) }, "idle_expired"],
  ])("%s session → rejected", (_label, session, reason) => {
    expect(decideRefresh({ rotatedAt: null, isLatestRotated: false }, session, NOW)).toEqual({
      action: "reject",
      reason,
    });
  });

  it("the idle deadline moves forward but never past the absolute end", () => {
    expect(nextIdleExpiry(NOW, 24, sec(7 * 86_400))).toEqual(sec(24 * 3600));
    expect(nextIdleExpiry(NOW, 24, sec(3600))).toEqual(sec(3600));
  });
});

describe("access tokens (HS256, jose)", () => {
  const tokens = createAccessTokens({ secret: "a".repeat(40), ttlSeconds: 900 });
  const claims = { sub: "u1", role: "operator" as const, sid: "s1" };

  it("round-trips and expires after the TTL", async () => {
    const token = await tokens.sign(claims, NOW);
    expect(await tokens.verify(token, sec(899))).toEqual(claims);
    expect(await tokens.verify(token, sec(901))).toBeNull();
  });

  it("rejects another key, a tampered payload and alg none", async () => {
    const token = await tokens.sign(claims, NOW);
    const other = createAccessTokens({ secret: "b".repeat(40), ttlSeconds: 900 });
    expect(await other.verify(token, NOW)).toBeNull();
    const [h, p, s] = token.split(".");
    const tampered = Buffer.from(p as string, "base64url")
      .toString()
      .replace("operator", "admin");
    expect(
      await tokens.verify(`${h}.${Buffer.from(tampered).toString("base64url")}.${s}`, NOW),
    ).toBeNull();
    const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${p}.`;
    expect(await tokens.verify(none, NOW)).toBeNull();
  });

  it("refresh tokens are random 256-bit values; only a SHA-256 is stored", () => {
    const a = newRefreshToken();
    expect(Buffer.from(a, "base64url")).toHaveLength(32);
    expect(a).not.toBe(newRefreshToken());
    expect(hashRefreshToken(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("refresh cookie per deploy mode", () => {
  const base = { NODE_ENV: "production" as const, AUTH_COOKIE_PARTITIONED: false };

  it("same origin (option D / A): __Secure-, HttpOnly, Strict, auth path only", () => {
    expect(
      refreshCookieConfig({ ...base, AUTH_COOKIE_SAMESITE: "strict", AUTH_COOKIE_SECURE: "auto" }),
    ).toEqual({
      name: "__Secure-smartops_rt",
      options: { httpOnly: true, secure: true, sameSite: "strict", path: "/api/v1/auth" },
    });
  });

  it("cross-site (option C): None + Partitioned", () => {
    expect(
      refreshCookieConfig({
        ...base,
        AUTH_COOKIE_SAMESITE: "none",
        AUTH_COOKIE_SECURE: "true",
        AUTH_COOKIE_PARTITIONED: true,
      }).options,
    ).toMatchObject({ sameSite: "none", secure: true, partitioned: true });
  });

  it("local http development: not Secure (and no __Secure- prefix)", () => {
    expect(
      refreshCookieConfig({
        NODE_ENV: "development",
        AUTH_COOKIE_SAMESITE: "strict",
        AUTH_COOKIE_SECURE: "auto",
        AUTH_COOKIE_PARTITIONED: false,
      }),
    ).toMatchObject({ name: "smartops_rt", options: { secure: false } });
  });

  it("reads one cookie from the header", () => {
    const req = { headers: { cookie: "a=1; smartops_rt=abc%3D; b=2" } } as never;
    expect(readCookie(req, "smartops_rt")).toBe("abc=");
    expect(readCookie(req, "missing")).toBeUndefined();
  });
});

describe("CSRF guard on the cookie routes", () => {
  function app(sameSite: "strict" | "none") {
    const a = express();
    a.post(
      "/x",
      createCsrfGuard({ allowedOrigins: ["https://panel.example.com"], sameSite }),
      (_q, r) => r.status(204).end(),
    );
    a.use(createErrorHandler({ isProduction: false }));
    return a;
  }
  const ok = { "x-smartops-csrf": "1", origin: "https://panel.example.com" };

  it("passes with the header and an allowed origin", async () => {
    await request(app("strict")).post("/x").set(ok).expect(204);
  });

  it("accepts the API's own origin (same-origin deploy)", async () => {
    await request(app("strict"))
      .post("/x")
      .set("host", "smartops.example.com")
      .set({ "x-smartops-csrf": "1", origin: "http://smartops.example.com" })
      .expect(204);
  });

  it.each([
    ["no custom header", { origin: "https://panel.example.com" }],
    ["no origin", { "x-smartops-csrf": "1" }],
    ["foreign origin", { "x-smartops-csrf": "1", origin: "https://evil.example" }],
    ["cross-site fetch metadata", { ...ok, "sec-fetch-site": "cross-site" }],
  ])("403 for %s", async (_label, headers) => {
    const res = await request(app("strict")).post("/x").set(headers);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("cross-site mode (SameSite=None) cannot reject cross-site fetch metadata, still checks origin", async () => {
    await request(app("none"))
      .post("/x")
      .set({ ...ok, "sec-fetch-site": "cross-site" })
      .expect(204);
  });
});
