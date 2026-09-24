import { describe, expect, it } from "vitest";
import { EnvValidationError, parseEnv } from "../../src/config/env.js";
import { TEST_WHATSAPP_ENV } from "../helpers/build-app.js";

const base: Record<string, string> = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  ...TEST_WHATSAPP_ENV,
};
/** Production needs a real transcription provider; isolates the rule under test. */
const prodBase: Record<string, string> = {
  ...base,
  NODE_ENV: "production",
  TRANSCRIPTION_PROVIDER: "groq",
  TRANSCRIPTION_API_KEY: "gsk_test_key_not_real",
};
const baseWithoutDb = Object.fromEntries(
  Object.entries(base).filter(([key]) => key !== "DATABASE_URL"),
);

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
    expect(issuesOf(baseWithoutDb)).toEqual([expect.stringContaining("DATABASE_URL")]);
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
    expect(issuesOf(prodBase)).toEqual(["CORS_ORIGINS: is required in production"]);
  });

  it("treats a blank CORS_ORIGINS list as missing in production", () => {
    expect(issuesOf({ ...prodBase, CORS_ORIGINS: " , " })).toEqual([
      "CORS_ORIGINS: is required in production",
    ]);
  });

  it("reports cross-field problems together with field errors", () => {
    const issues = issuesOf({ ...prodBase, LOG_LEVEL: "loud" });
    expect(issues).toEqual([
      expect.stringContaining("LOG_LEVEL"),
      "CORS_ORIGINS: is required in production",
    ]);
  });

  it("reports every problem at once", () => {
    expect(issuesOf({ ...baseWithoutDb, PORT: "abc", LOG_LEVEL: "loud" }).length).toBe(3);
  });

  it("applies WhatsApp defaults", () => {
    expect(parseEnv(base)).toMatchObject({
      WHATSAPP_GRAPH_API_VERSION: "v26.0",
      WHATSAPP_API_TIMEOUT_MS: 15_000,
      WEBHOOK_RATE_LIMIT_MAX: 600,
    });
  });

  it("requires every WhatsApp credential", () => {
    const issues = issuesOf({ DATABASE_URL: base.DATABASE_URL! });
    for (const name of [
      "WHATSAPP_PHONE_NUMBER_ID",
      "WHATSAPP_WABA_ID",
      "WHATSAPP_ACCESS_TOKEN",
      "WHATSAPP_APP_SECRET",
      "WHATSAPP_VERIFY_TOKEN",
    ]) {
      expect(issues).toContainEqual(expect.stringContaining(name));
    }
  });

  it("rejects malformed WhatsApp values", () => {
    const issues = issuesOf({
      ...base,
      WHATSAPP_GRAPH_API_VERSION: "26",
      WHATSAPP_PHONE_NUMBER_ID: "+598 123",
      WHATSAPP_VERIFY_TOKEN: "short",
    });
    expect(issues).toEqual([
      expect.stringContaining("WHATSAPP_GRAPH_API_VERSION"),
      expect.stringContaining("WHATSAPP_PHONE_NUMBER_ID"),
      expect.stringContaining("WHATSAPP_VERIFY_TOKEN"),
    ]);
  });

  describe("WHATSAPP_GRAPH_BASE_URL", () => {
    it("defaults to Meta and strips trailing slashes", () => {
      expect(parseEnv(base).WHATSAPP_GRAPH_BASE_URL).toBe("https://graph.facebook.com");
      expect(
        parseEnv({ ...base, WHATSAPP_GRAPH_BASE_URL: "http://localhost:4010/" })
          .WHATSAPP_GRAPH_BASE_URL,
      ).toBe("http://localhost:4010");
    });

    it("rejects URLs with a path or another protocol", () => {
      expect(
        issuesOf({ ...base, WHATSAPP_GRAPH_BASE_URL: "http://localhost:4010/v26.0" })[0],
      ).toContain("WHATSAPP_GRAPH_BASE_URL");
      expect(issuesOf({ ...base, WHATSAPP_GRAPH_BASE_URL: "ftp://x" })[0]).toContain(
        "WHATSAPP_GRAPH_BASE_URL",
      );
    });

    it("only allows Meta in production (the fake Graph API can never ship)", () => {
      const prod = { ...prodBase, CORS_ORIGINS: "https://admin.example.com" };
      expect(issuesOf({ ...prod, WHATSAPP_GRAPH_BASE_URL: "http://localhost:4010" })).toEqual([
        "WHATSAPP_GRAPH_BASE_URL: must be https://graph.facebook.com in production",
      ]);
      expect(
        parseEnv({ ...prod, WHATSAPP_GRAPH_BASE_URL: "https://graph.facebook.com/" }),
      ).toBeTruthy();
      expect(parseEnv(prod).WHATSAPP_GRAPH_BASE_URL).toBe("https://graph.facebook.com");
    });
  });
});
