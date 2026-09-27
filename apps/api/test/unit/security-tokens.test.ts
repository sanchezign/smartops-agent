import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { createAccessTokens, JWT_AUDIENCE, JWT_ISSUER } from "../../src/modules/auth/tokens.js";

/**
 * Access-token forgery matrix (phase 10 M6). auth-sessions.test.ts already covers expiry,
 * another key, a tampered payload and alg "none"; here every OTHER way a token signed with
 * the right key can still be wrong: issuer, audience, algorithm, missing / unexpected claims,
 * not-yet-valid, malformed input. Every one must verify to null (→ 401).
 */

const SECRET = "k".repeat(40);
const key = new TextEncoder().encode(SECRET);
const tokens = createAccessTokens({ secret: SECRET, ttlSeconds: 900 });
const NOW = new Date("2026-09-27T12:00:00.000Z");
const iat = Math.floor(NOW.getTime() / 1000);

function forge(
  opts: {
    alg?: string;
    iss?: string | null;
    aud?: string | null;
    sub?: string | null;
    claims?: Record<string, unknown>;
    exp?: number | null;
    nbf?: number;
  } = {},
) {
  const jwt = new SignJWT({ role: "operator", sid: "s1", ...opts.claims })
    .setProtectedHeader({ alg: opts.alg ?? "HS256", typ: "JWT" })
    .setIssuedAt(iat);
  if (opts.sub !== null) jwt.setSubject(opts.sub ?? "u1");
  if (opts.iss !== null) jwt.setIssuer(opts.iss ?? JWT_ISSUER);
  if (opts.aud !== null) jwt.setAudience(opts.aud ?? JWT_AUDIENCE);
  if (opts.exp !== null) jwt.setExpirationTime(opts.exp ?? iat + 900);
  if (opts.nbf !== undefined) jwt.setNotBefore(opts.nbf);
  return jwt.sign(key);
}

describe("access token forgery matrix", () => {
  it("the control token (everything right) verifies", async () => {
    expect(await tokens.verify(await forge(), NOW)).toEqual({
      sub: "u1",
      role: "operator",
      sid: "s1",
    });
  });

  it.each([
    ["another issuer", { iss: "someone-else" }],
    ["no issuer", { iss: null }],
    ["another audience", { aud: "smartops-api" }],
    ["no audience", { aud: null }],
    ["HS512 with the same key (algorithm pinned to HS256)", { alg: "HS512" }],
    ["no subject", { sub: null }],
    ["no session id", { claims: { sid: undefined } }],
    ["a role that does not exist", { claims: { role: "superadmin" } }],
    ["the role as an array", { claims: { role: ["admin"] } }],
    ["not valid yet (nbf in the future)", { nbf: iat + 3_600 }],
    ["expired a second ago", { exp: iat - 1 }],
  ] as const)("rejects %s", async (_label, opts) => {
    expect(await tokens.verify(await forge(opts as Parameters<typeof forge>[0]), NOW)).toBeNull();
  });

  it.each([
    ["an empty string", ""],
    ["garbage", "not.a.jwt"],
    ["two segments", "eyJhbGciOiJIUzI1NiJ9.e30"],
    ["a huge token", "a".repeat(100_000)],
  ])("rejects %s without throwing", async (_label, token) => {
    expect(await tokens.verify(token, NOW)).toBeNull();
  });

  // FINDING (phase 10 M6, reported, not changed): verify() does not REQUIRE `exp`, so a token
  // signed with the real key but without an expiry would never expire. Only exploitable by
  // someone who already holds JWT_ACCESS_SECRET; fix = jwtVerify({ requiredClaims: ["exp",
  // "iat", "sub"] }). `it.fails` passes while the gap exists and turns red once it is fixed —
  // then change it to `it`.
  it.fails("rejects a token WITHOUT exp (never expiring)", async () => {
    expect(await tokens.verify(await forge({ exp: null }), NOW)).toBeNull();
  });
});
