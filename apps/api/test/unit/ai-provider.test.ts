import { readFileSync } from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { LlmError, type StructuredRequest } from "../../src/ai/llm-provider.js";
import { createAnthropicProvider } from "../../src/ai/providers/anthropic.js";
import { createFakeLlmProvider, fakeContentKey } from "../../src/ai/providers/fake.js";

/**
 * The Anthropic provider is exercised with an injected fetch: the real SDK builds the
 * HTTP request, nothing leaves the machine and no credits are spent.
 */

const PDF = readFileSync(new URL("../fixtures/extraction/lista-prueba.pdf", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "smartops-ai-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const schema = z.object({
  classification: z.enum(["price_list", "other"]),
  confidence: z.number().min(0).max(1),
});

function request(
  overrides: Partial<StructuredRequest<z.infer<typeof schema>>> = {},
): StructuredRequest<z.infer<typeof schema>> {
  return {
    task: "classify",
    model: "claude-sonnet-5",
    system: "Short system prompt.",
    cacheSystem: true,
    content: [{ type: "text", text: "Lista septiembre: tornillo 6mm 12 UYU" }],
    jsonSchema: { type: "object", properties: {}, additionalProperties: false },
    schema,
    effort: "low",
    maxTokens: 300,
    ...overrides,
  };
}

function apiResponse(
  body: Record<string, unknown>,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function message(text: string, extra: Record<string, unknown> = {}) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 1200,
      output_tokens: 80,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    ...extra,
  };
}

function providerWith(responses: Response[]) {
  const calls: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      headers: new Headers(init?.headers),
    });
    const next = responses.shift();
    if (!next) throw new Error("no more fake responses");
    return next;
  }) as typeof fetch;
  const provider = createAnthropicProvider({
    apiKey: "sk-ant-test-not-real-000000",
    timeoutMs: 5_000,
    maxRetries: 0,
    fetch: fetchImpl,
  });
  return { provider, calls };
}

describe("anthropic provider (injected fetch)", () => {
  it("sends structured outputs, effort, and content blocks; parses usage", async () => {
    const { provider, calls } = providerWith([
      apiResponse(
        message(JSON.stringify({ classification: "price_list", confidence: 0.93 }), {
          usage: {
            input_tokens: 900,
            output_tokens: 40,
            cache_read_input_tokens: 1100,
            cache_creation_input_tokens: 0,
          },
        }),
      ),
    ]);
    const result = await provider.generateStructured(
      request({
        content: [
          { type: "pdf", data: PDF, title: "lista-prueba.pdf" },
          { type: "text", text: "extraer" },
        ],
      }),
    );

    expect(result.data).toEqual({ classification: "price_list", confidence: 0.93 });
    expect(result.usage).toEqual({
      inputTokens: 900,
      outputTokens: 40,
      cacheReadTokens: 1100,
      cacheWriteTokens: 0,
    });
    const call = calls[0];
    expect(call?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call?.headers.get("x-api-key")).toBe("sk-ant-test-not-real-000000");
    expect(call?.body).toMatchObject({
      model: "claude-sonnet-5",
      max_tokens: 300,
      output_config: { effort: "low", format: { type: "json_schema", schema: { type: "object" } } },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              title: "lista-prueba.pdf",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: PDF.toString("base64"),
              },
            },
            { type: "text", text: "extraer" },
          ],
        },
      ],
    });
  });

  it("caches the system prompt only when it reaches the model's minimum", async () => {
    const { provider, calls } = providerWith([
      apiResponse(message(JSON.stringify({ classification: "other", confidence: 0.5 }))),
      apiResponse(message(JSON.stringify({ classification: "other", confidence: 0.5 }))),
    ]);
    await provider.generateStructured(request({ system: "short" }));
    await provider.generateStructured(request({ system: "x".repeat(5_000) }));
    const systemOf = (i: number) => (calls[i]?.body.system as { cache_control?: unknown }[])[0];
    expect(systemOf(0)?.cache_control).toBeUndefined();
    expect(systemOf(1)?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("sends images as base64 image blocks", async () => {
    const { provider, calls } = providerWith([
      apiResponse(message(JSON.stringify({ classification: "other", confidence: 0.2 }))),
    ]);
    await provider.generateStructured(
      request({
        content: [
          { type: "image", mediaType: "image/jpeg", data: Buffer.from([0xff, 0xd8, 0xff]) },
        ],
      }),
    );
    expect((calls[0]?.body.messages as { content: unknown[] }[])[0]?.content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "/9j/" },
    });
  });

  it.each([
    ["a refusal", message("", { stop_reason: "refusal" }), /refused/],
    ["truncated output", message('{"classification":', { stop_reason: "max_tokens" }), /truncated/],
    ["non-JSON output", message("not json"), /not valid JSON/],
    [
      "out-of-range values (Zod)",
      message(JSON.stringify({ classification: "price_list", confidence: 7 })),
      /confidence/,
    ],
  ])("maps %s to invalid_output keeping the billed usage", async (_label, body, pattern) => {
    const { provider } = providerWith([apiResponse(body)]);
    const err = await provider.generateStructured(request()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err).toMatchObject({
      kind: "invalid_output",
      retryable: false,
      usage: { inputTokens: 1200, outputTokens: 80 },
    });
    expect((err as Error).message).toMatch(pattern);
  });

  it.each([
    [401, "auth", false],
    [429, "rate_limited", true],
    [529, "unavailable", true],
    [500, "unavailable", true],
    [400, "bad_request", false],
  ] as const)("maps HTTP %s to %s", async (status, kind, retryable) => {
    const { provider } = providerWith([
      apiResponse({ type: "error", error: { type: "error", message: `status ${status}` } }, status),
    ]);
    await expect(provider.generateStructured(request())).rejects.toMatchObject({ kind, retryable });
  });
});

describe("fake LLM provider", () => {
  it("returns a recorded golden output for the exact content", async () => {
    const content = [{ type: "pdf" as const, data: PDF }];
    const key = fakeContentKey("classify", content);
    mkdirSync(join(tmp, "classify"), { recursive: true });
    writeFileSync(
      join(tmp, "classify", `${key}.json`),
      JSON.stringify({ classification: "price_list", confidence: 0.99 }),
    );
    const fake = createFakeLlmProvider({ goldenDir: tmp });
    const result = await fake.generateStructured(request({ content }));
    expect(result).toMatchObject({
      data: { classification: "price_list", confidence: 0.99 },
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });

  it("falls back to a responder, and validates its output with the same schema", async () => {
    const fake = createFakeLlmProvider({
      responders: { classify: () => ({ classification: "other", confidence: 0.4 }) },
    });
    expect((await fake.generateStructured(request())).data).toEqual({
      classification: "other",
      confidence: 0.4,
    });

    const broken = createFakeLlmProvider({
      responders: { classify: () => ({ classification: "nope" }) },
    });
    await expect(broken.generateStructured(request())).rejects.toMatchObject({
      kind: "invalid_output",
    });
  });

  it("fails like a model that cannot answer when nothing matches", async () => {
    await expect(createFakeLlmProvider().generateStructured(request())).rejects.toMatchObject({
      kind: "invalid_output",
    });
  });

  it("content keys depend on task and exact content", () => {
    const a = fakeContentKey("classify", [{ type: "text", text: "hola" }]);
    expect(fakeContentKey("classify", [{ type: "text", text: "hola" }])).toBe(a);
    expect(fakeContentKey("extract", [{ type: "text", text: "hola" }])).not.toBe(a);
    expect(fakeContentKey("classify", [{ type: "text", text: "hola!" }])).not.toBe(a);
  });
});
