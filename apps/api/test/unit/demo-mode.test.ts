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

  it("runs as production (fakes allowed only because DEMO_MODE is explicit)", () => {
    const env = parseEnv({
      ...demoSource,
      NODE_ENV: "production",
      CORS_ORIGINS: "https://demo.x.uy",
    });
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
