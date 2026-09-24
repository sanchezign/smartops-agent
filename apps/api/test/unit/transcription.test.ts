import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { parseEnv } from "../../src/config/env.js";
import { createFakeTranscriber } from "../../src/modules/transcription/providers/fake.js";
import {
  audioExtension,
  classifyHttpError,
  createOpenAiCompatibleTranscriber,
} from "../../src/modules/transcription/providers/openai-compatible.js";
import {
  createTranscriber,
  loadVocabularyPrompt,
  MAX_PROMPT_CHARS,
} from "../../src/modules/transcription/transcriber.factory.js";
import { TranscriptionError } from "../../src/modules/transcription/transcriber.js";
import { SAMPLES } from "../helpers/media-samples.js";
import { TEST_ENV_SOURCE } from "../helpers/build-app.js";

const tmp = mkdtempSync(join(tmpdir(), "smartops-stt-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());

function groq(overrides: Partial<Parameters<typeof createOpenAiCompatibleTranscriber>[0]> = {}) {
  return createOpenAiCompatibleTranscriber({
    provider: "groq",
    baseUrl: "https://api.groq.com/openai/v1/",
    apiKey: "gsk_test_key_not_real",
    model: "whisper-large-v3",
    timeoutMs: 5_000,
    ...overrides,
  });
}

function stubFetch(response: Response | (() => never)) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (typeof response === "function") return response();
      return response;
    }),
  );
  return calls;
}

describe("openai-compatible transcriber (Groq)", () => {
  it("posts a multipart request like the OpenAI audio API", async () => {
    const calls = stubFetch(
      new Response(
        JSON.stringify({
          text: " Tornillo de 6 mm a 14 pesos. ",
          language: "spanish",
          duration: 7.52,
        }),
      ),
    );
    const result = await groq().transcribe({
      bytes: SAMPLES.ogg,
      mimeType: "audio/ogg; codecs=opus",
      language: "es",
      prompt: "lista de precios",
    });

    expect(result).toMatchObject({
      text: "Tornillo de 6 mm a 14 pesos.",
      provider: "groq",
      model: "whisper-large-v3",
      language: "spanish",
      durationSeconds: 7.52,
    });
    const call = calls[0];
    expect(call?.url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(call?.init.method).toBe("POST");
    expect((call?.init.headers as Record<string, string>).Authorization).toBe(
      "Bearer gsk_test_key_not_real",
    );
    const form = call?.init.body as FormData;
    expect(form.get("model")).toBe("whisper-large-v3");
    expect(form.get("language")).toBe("es");
    expect(form.get("prompt")).toBe("lista de precios");
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.get("temperature")).toBe("0");
    const file = form.get("file") as File;
    expect(file.name).toBe("audio.ogg"); // providers infer the format from the extension
    expect(file.type).toBe("audio/ogg");
    expect(Buffer.from(await file.arrayBuffer())).toEqual(SAMPLES.ogg);
  });

  it("uses plain json for non-Whisper models (gpt-4o transcribe)", async () => {
    const calls = stubFetch(new Response(JSON.stringify({ text: "hola" })));
    const openai = createOpenAiCompatibleTranscriber({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test-not-real-000",
      model: "gpt-4o-mini-transcribe",
      timeoutMs: 5_000,
    });
    const result = await openai.transcribe({ bytes: SAMPLES.mp3, mimeType: "audio/mpeg" });
    expect((calls[0]?.init.body as FormData).get("response_format")).toBe("json");
    expect(result).toMatchObject({ text: "hola", durationSeconds: null, language: null });
  });

  it("knows which formats each provider accepts as-is", () => {
    const openai = createOpenAiCompatibleTranscriber({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test-not-real-000",
      model: "whisper-1",
      timeoutMs: 1,
    });
    expect(groq().supports("audio/ogg; codecs=opus")).toBe(true);
    expect(openai.supports("audio/ogg; codecs=opus")).toBe(false);
    for (const t of [groq(), openai]) {
      expect(t.supports("audio/mpeg")).toBe(true);
      expect(t.supports("audio/mp4")).toBe(true);
      expect(t.supports("audio/aac")).toBe(false);
      expect(t.supports("audio/amr")).toBe(false);
    }
    expect(audioExtension("audio/mp4")).toBe("m4a");
  });

  it("refuses unsupported formats without calling the provider", async () => {
    const calls = stubFetch(new Response("{}"));
    await expect(
      groq().transcribe({ bytes: SAMPLES.amr, mimeType: "audio/amr" }),
    ).rejects.toMatchObject({
      kind: "invalid_audio",
      retryable: false,
    });
    expect(calls).toHaveLength(0);
  });

  it("maps a timeout to a retryable error", async () => {
    stubFetch(() => {
      throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
    });
    await expect(
      groq().transcribe({ bytes: SAMPLES.ogg, mimeType: "audio/ogg" }),
    ).rejects.toMatchObject({
      kind: "timeout",
      retryable: true,
    });
  });

  it("maps HTTP errors (and keeps retry-after for 429)", async () => {
    stubFetch(
      new Response(JSON.stringify({ error: { message: "Rate limit reached for model" } }), {
        status: 429,
        headers: { "retry-after": "12" },
      }),
    );
    const err = await groq()
      .transcribe({ bytes: SAMPLES.ogg, mimeType: "audio/ogg" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TranscriptionError);
    expect(err).toMatchObject({
      kind: "rate_limited",
      retryable: true,
      retryAfterSeconds: 12,
      httpStatus: 429,
    });
  });

  it("rejects responses without text", async () => {
    stubFetch(new Response(JSON.stringify({ foo: 1 })));
    await expect(
      groq().transcribe({ bytes: SAMPLES.ogg, mimeType: "audio/ogg" }),
    ).rejects.toMatchObject({
      kind: "transient",
    });
  });
});

describe("classifyHttpError", () => {
  it.each([
    [400, "invalid_audio", false],
    [413, "invalid_audio", false],
    [415, "invalid_audio", false],
    [401, "unauthorized", true],
    [403, "unauthorized", true],
    [429, "rate_limited", true],
    [500, "transient", true],
    [503, "transient", true],
  ] as const)("HTTP %s → %s (retryable %s)", (status, kind, retryable) => {
    expect(classifyHttpError(status, "", null)).toMatchObject({
      kind,
      retryable,
      httpStatus: status,
    });
  });

  it("includes the provider message but never the whole body", () => {
    const err = classifyHttpError(
      400,
      JSON.stringify({ error: { message: "file must be one of…" } }),
      null,
    );
    expect(err.message).toBe("Transcription failed with HTTP 400: file must be one of…");
  });
});

describe("fake transcriber", () => {
  it("returns the transcript registered for the audio's sha256", async () => {
    const sha = createHash("sha256").update(SAMPLES.ogg).digest("hex");
    writeFileSync(join(tmp, `${sha}.txt`), "El tornillo de 6mm sube a 14 pesos\n");
    const fake = createFakeTranscriber({ transcriptsDir: tmp });
    expect(
      await fake.transcribe({ bytes: SAMPLES.ogg, mimeType: "audio/ogg", language: "es" }),
    ).toMatchObject({
      text: "El tornillo de 6mm sube a 14 pesos",
      provider: "fake",
      language: "es",
    });
  });

  it("returns a placeholder otherwise, and accepts the same formats as Groq", async () => {
    const fake = createFakeTranscriber({ transcriptsDir: tmp });
    expect((await fake.transcribe({ bytes: SAMPLES.mp3, mimeType: "audio/mpeg" })).text).toMatch(
      /^\[transcripción simulada: audio\/mpeg, \d+ bytes\]$/,
    );
    expect(fake.supports("audio/ogg")).toBe(true);
    expect(fake.supports("audio/aac")).toBe(false);
  });
});

describe("factory and configuration", () => {
  const env = (extra: Record<string, string> = {}) => parseEnv({ ...TEST_ENV_SOURCE, ...extra });

  it("defaults to the fake provider", () => {
    expect(createTranscriber(env()).provider).toBe("fake");
  });

  it("builds Groq with its defaults (base URL + whisper-large-v3)", () => {
    const t = createTranscriber(
      env({ TRANSCRIPTION_PROVIDER: "groq", TRANSCRIPTION_API_KEY: "gsk_test_key_not_real" }),
    );
    expect(t).toMatchObject({ provider: "groq", model: "whisper-large-v3" });
  });

  it("requires an API key for real providers and forbids fake in production", () => {
    const issues = (source: Record<string, string>) => {
      try {
        parseEnv({ ...TEST_ENV_SOURCE, ...source });
        return [];
      } catch (err) {
        return (err as { issues: string[] }).issues;
      }
    };
    expect(issues({ TRANSCRIPTION_PROVIDER: "groq", TRANSCRIPTION_API_KEY: "" })).toEqual([
      "TRANSCRIPTION_API_KEY: is required when TRANSCRIPTION_PROVIDER=groq",
    ]);
    expect(issues({ NODE_ENV: "production" })).toContain(
      "TRANSCRIPTION_PROVIDER: the fake provider is not allowed in production",
    );
    expect(issues({ TRANSCRIPTION_LANGUAGE: "spanish" })[0]).toContain("TRANSCRIPTION_LANGUAGE");
  });

  it("treats empty optional values as unset", () => {
    expect(env({ TRANSCRIPTION_BASE_URL: "", TRANSCRIPTION_MODEL: "" })).toMatchObject({
      TRANSCRIPTION_BASE_URL: undefined,
      TRANSCRIPTION_MODEL: undefined,
    });
  });

  it("loads the versioned vocabulary prompt within Whisper's limit", () => {
    const prompt = loadVocabularyPrompt();
    expect(prompt.length).toBeGreaterThan(50);
    expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
    expect(prompt).toContain("lista de precios");
  });

  it("fails fast if the vocabulary prompt grows beyond the limit", () => {
    const path = join(tmp, "too-long.md");
    writeFileSync(path, "palabra ".repeat(200));
    expect(() => loadVocabularyPrompt(pathToFileURL(path))).toThrow(/224 tokens/);
  });
});
