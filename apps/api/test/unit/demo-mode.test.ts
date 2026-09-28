import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEnv } from "../../src/config/env.js";
import {
  DemoModeBlockedError,
  graphRequest,
  isMetaHost,
} from "../../src/modules/whatsapp/graph-api.js";
import { isAllowedDownloadUrl } from "../../src/modules/whatsapp/whatsapp-media.client.js";
import { createWhatsAppSendClient } from "../../src/modules/whatsapp/whatsapp-send.client.js";
import { TEST_ENV_SOURCE } from "../helpers/build-app.js";

/**
 * DEMO_MODE (phase 9 M8, ADR-021) — user requirement: in the public demo NO real WhatsApp
 * message can ever leave. Checked at every layer: configuration (forced fake Graph API, fake
 * LLM and transcriber, *_demo database), the Graph client (Meta hosts refused before any
 * network call) and media downloads.
 */

const DEMO_DB = "postgresql://u:p@localhost:5432/smartops_demo";
const demoSource = {
  ...TEST_ENV_SOURCE,
  DATABASE_URL: DEMO_DB,
  DEMO_MODE: "true",
  PORT: "4321",
  // Everything a careless deploy could leave pointing at real services:
  WHATSAPP_GRAPH_BASE_URL: "https://graph.facebook.com",
  AI_PROVIDER: "anthropic",
  ANTHROPIC_API_KEY: "sk-ant-test-key-not-real-0000",
  TRANSCRIPTION_PROVIDER: "groq",
  TRANSCRIPTION_API_KEY: "gsk_test_key_not_real",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("configuration", () => {
  it("forces the demo's own Graph API, the fake LLM and the fake transcriber", () => {
    const env = parseEnv(demoSource);
    expect(env.DEMO_MODE).toBe(true);
    expect(env.WHATSAPP_GRAPH_BASE_URL).toBe("http://127.0.0.1:4321");
    expect(env.AI_PROVIDER).toBe("fake");
    expect(env.TRANSCRIPTION_PROVIDER).toBe("fake");
    expect(env.AI_FAKE_GOLDEN_DIR).toBe("demo/golden");
    expect(env.TRANSCRIPTION_FAKE_DIR).toBe("demo/transcripts");
  });

  // The public demo server as deployed (phase 12): production, and not a single real key.
  const publicDemo = {
    ...demoSource,
    NODE_ENV: "production",
    CORS_ORIGINS: "https://demo.x.uy",
    ANTHROPIC_API_KEY: "",
    TRANSCRIPTION_API_KEY: "",
  };

  it("runs as production (fakes allowed only because DEMO_MODE is explicit)", () => {
    const env = parseEnv(publicDemo);
    expect(env.NODE_ENV).toBe("production");
    expect(() =>
      parseEnv({
        ...demoSource,
        DEMO_MODE: "false",
        NODE_ENV: "production",
        CORS_ORIGINS: "https://x.uy",
        AI_PROVIDER: "fake",
      }),
    ).toThrow(/fake provider is not allowed/);
  });

  it("the public demo refuses to start while ANY real key is present, or with a demo admin", () => {
    const refused = (extra: Record<string, string>, message: RegExp) => {
      let error: unknown;
      try {
        parseEnv({ ...publicDemo, ...extra });
      } catch (err) {
        error = err;
      }
      expect(String(error)).toMatch(message);
      // The offending value is never echoed back (logs, crash reports).
      for (const value of Object.values(extra)) expect(String(error)).not.toContain(value);
    };
    refused(
      { ANTHROPIC_API_KEY: "sk-ant-api03-not-a-real-key-0000" },
      /ANTHROPIC_API_KEY: must be empty/,
    );
    refused(
      { TRANSCRIPTION_API_KEY: "gsk_not_a_real_key_000000" },
      /TRANSCRIPTION_API_KEY: must be empty/,
    );
    refused({ DEMO_ADMIN_PASSWORD: "una contraseña de admin larguísima" }, /no admin account/);
    // A real key hidden under another name (a careless copy of a real .env).
    refused(
      { WHATSAPP_ACCESS_TOKEN: `EAA${"B".repeat(40)}` },
      /WHATSAPP_ACCESS_TOKEN: looks like a Meta access token/,
    );
    refused(
      { SOME_OTHER_VAR: "sk-ant-api03-another-not-real-key" },
      /SOME_OTHER_VAR: looks like an Anthropic API key/,
    );
    refused(
      { SOME_OTHER_VAR: "gsk_another_not_real_key_00" },
      /SOME_OTHER_VAR: looks like a Groq API key/,
    );
    // Local demo (development): the developer's .env may hold real keys; DEMO_MODE still forces
    // the fakes, so it keeps working there.
    expect(() => parseEnv(demoSource)).not.toThrow();
  });

  it("refuses to start on a database that is not *_demo (the demo resets its data)", () => {
    expect(() =>
      parseEnv({ ...demoSource, DATABASE_URL: "postgresql://u:p@localhost:5432/smartops" }),
    ).toThrow(/DEMO_MODE: DATABASE_URL must point to a \*_demo database/);
  });
});

describe("the Graph client never reaches Meta in demo mode", () => {
  const config = (baseUrl: string) => ({
    baseUrl,
    version: "v26.0",
    accessToken: "token",
    timeoutMs: 1_000,
    blockMeta: true,
  });

  it.each([
    "https://graph.facebook.com",
    "https://GRAPH.FACEBOOK.COM.",
    "https://lookaside.fbsbx.com",
    "https://api.whatsapp.com",
  ])("%s is refused before any network call", async (baseUrl) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(graphRequest(config(baseUrl), "GET", "123")).rejects.toBeInstanceOf(
      DemoModeBlockedError,
    );
    const client = createWhatsAppSendClient({ graph: config(baseUrl), phoneNumberId: "1" });
    await expect(
      client.send({
        messaging_product: "whatsapp",
        to: "59899000000",
        type: "text",
        text: { body: "hola" },
      }),
    ).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the configuration built from the demo env only ever talks to the demo's own host", async () => {
    const env = parseEnv(demoSource);
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return new Response(
          JSON.stringify({
            messages: [{ id: "wamid.DEMO" }],
            contacts: [{ wa_id: "59899000000" }],
          }),
          {
            headers: { "content-type": "application/json" },
          },
        );
      }),
    );
    const client = createWhatsAppSendClient({
      graph: {
        baseUrl: env.WHATSAPP_GRAPH_BASE_URL,
        version: env.WHATSAPP_GRAPH_API_VERSION,
        accessToken: env.WHATSAPP_ACCESS_TOKEN,
        timeoutMs: 1_000,
        blockMeta: env.DEMO_MODE,
      },
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
    });
    await client.send({
      messaging_product: "whatsapp",
      to: "59899000000",
      type: "text",
      text: { body: "hola" },
    });
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]!).host).toBe("127.0.0.1:4321");
  });

  it("media downloads: Meta's CDN is refused, only the demo's own host is allowed", () => {
    const opts = { graphBaseUrl: "http://127.0.0.1:4321", production: true, demoMode: true };
    expect(isAllowedDownloadUrl("https://lookaside.fbsbx.com/whatsapp_business/x", opts)).toBe(
      false,
    );
    expect(isAllowedDownloadUrl("http://127.0.0.1:4321/media-download/abc", opts)).toBe(true);
    expect(isAllowedDownloadUrl("http://127.0.0.1:9999/media-download/abc", opts)).toBe(false);
  });

  it("isMetaHost: Meta domains and their subdomains only", () => {
    expect(isMetaHost("graph.facebook.com")).toBe(true);
    expect(isMetaHost("scontent.fbcdn.net")).toBe(true);
    expect(isMetaHost("notfacebook.com")).toBe(false);
    expect(isMetaHost("127.0.0.1")).toBe(false);
  });
});
