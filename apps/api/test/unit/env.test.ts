import { describe, expect, it } from "vitest";
import { EnvValidationError, parseEnv } from "../../src/config/env.js";

const base = { DATABASE_URL: "postgresql://u:p@localhost:5432/db" };

function issuesOf(source: Record<string, string>): string[] {
  try {
    parseEnv(source);
  } catch (err) {
    if (err instanceof EnvValidationError) return err.issues;
    throw err;
  }
  throw new Error("expected parseEnv to throw");
}

describe("parseEnv", () => {
  it("applies defaults", () => {
    const env = parseEnv(base);
    expect(env).toMatchObject({
      NODE_ENV: "development",
      PORT: 4000,
      LOG_LEVEL: "info",
      CORS_ORIGINS: [],
      RATE_LIMIT_WINDOW_MS: 60_000,
      RATE_LIMIT_MAX: 300,
      TRUST_PROXY: 0,
    });
  });

  it("coerces numbers and splits CORS origins", () => {
    const env = parseEnv({
      ...base,
      PORT: "8080",
      TRUST_PROXY: "1",
      CORS_ORIGINS: "http://localhost:3000, https://admin.example.com",
    });
    expect(env.PORT).toBe(8080);
    expect(env.TRUST_PROXY).toBe(1);
    expect(env.CORS_ORIGINS).toEqual(["http://localhost:3000", "https://admin.example.com"]);
  });

  it("fails when DATABASE_URL is missing", () => {
    expect(issuesOf({})).toEqual([expect.stringContaining("DATABASE_URL")]);
  });

  it("rejects a non-postgres DATABASE_URL", () => {
    expect(issuesOf({ DATABASE_URL: "mysql://x" })[0]).toContain("DATABASE_URL");
  });

  it("rejects the CORS wildcard", () => {
    expect(issuesOf({ ...base, CORS_ORIGINS: "*" })[0]).toContain("wildcard");
  });

  it("rejects CORS entries that are not bare origins", () => {
    expect(issuesOf({ ...base, CORS_ORIGINS: "https://a.example.com/path" })[0]).toContain(
      "CORS_ORIGINS",
    );
  });

  it("requires CORS_ORIGINS in production", () => {
    expect(issuesOf({ ...base, NODE_ENV: "production" })).toEqual([
      "CORS_ORIGINS: is required in production",
    ]);
  });

  it("treats a blank CORS_ORIGINS list as missing in production", () => {
    expect(issuesOf({ ...base, NODE_ENV: "production", CORS_ORIGINS: " , " })).toEqual([
      "CORS_ORIGINS: is required in production",
    ]);
  });

  it("reports cross-field problems together with field errors", () => {
    const issues = issuesOf({ ...base, NODE_ENV: "production", LOG_LEVEL: "loud" });
    expect(issues).toEqual([
      expect.stringContaining("LOG_LEVEL"),
      "CORS_ORIGINS: is required in production",
    ]);
  });

  it("reports every problem at once", () => {
    expect(issuesOf({ PORT: "abc", LOG_LEVEL: "loud" }).length).toBe(3);
  });
});
