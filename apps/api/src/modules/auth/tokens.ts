import { createHash, randomBytes } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import type { UserRole } from "../../generated/prisma/enums.js";

/**
 * Tokens (phase 8, ADR-018).
 * - Access: JWT HS256 (jose), short-lived (ACCESS_TOKEN_TTL_SECONDS, 15 min). Kept in the
 *   panel's MEMORY and sent as `Authorization: Bearer`. The API re-reads the session and the
 *   user on every request, so the role in the token is informational only.
 * - Refresh: opaque 256-bit random value (base64url) in an HttpOnly cookie; the database only
 *   stores its SHA-256.
 */

export const JWT_ISSUER = "smartops-api";
export const JWT_AUDIENCE = "smartops-panel";

export interface AccessClaims {
  sub: string;
  role: UserRole;
  sid: string;
}

export function createAccessTokens(config: { secret: string; ttlSeconds: number }) {
  const key = new TextEncoder().encode(config.secret);
  return {
    ttlSeconds: config.ttlSeconds,
    async sign(claims: AccessClaims, now = new Date()): Promise<string> {
      const iat = Math.floor(now.getTime() / 1000);
      return new SignJWT({ role: claims.role, sid: claims.sid })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setSubject(claims.sub)
        .setIssuer(JWT_ISSUER)
        .setAudience(JWT_AUDIENCE)
        .setIssuedAt(iat)
        .setExpirationTime(iat + config.ttlSeconds)
        .sign(key);
    },
    /** Null for anything invalid (signature, alg, issuer, audience, expiry, shape). */
    async verify(token: string, now = new Date()): Promise<AccessClaims | null> {
      try {
        const { payload } = await jwtVerify(token, key, {
          algorithms: ["HS256"],
          issuer: JWT_ISSUER,
          audience: JWT_AUDIENCE,
          currentDate: now,
          // Phase 10 M6 finding: without this, a token signed with the real key but missing
          // `exp` (or `iat`/`sub`) would verify forever. jose only checks claims it can find.
          requiredClaims: ["exp", "iat", "sub"],
        });
        const role = payload.role;
        if (
          typeof payload.sub !== "string" ||
          typeof payload.sid !== "string" ||
          (role !== "admin" && role !== "operator")
        )
          return null;
        return { sub: payload.sub, role, sid: payload.sid };
      } catch {
        return null;
      }
    },
  };
}
export type AccessTokens = ReturnType<typeof createAccessTokens>;

export function newRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
