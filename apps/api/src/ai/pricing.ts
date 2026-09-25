import type { LlmContent, TokenUsage } from "./llm-provider.js";

/**
 * Model prices in USD per million tokens (platform.claude.com/docs pricing, verified
 * 2026-09-25). Prompt cache: write = 1.25x input (5-minute TTL), read = 0.1x input.
 * A model missing from this table is refused at startup (never under-count costs).
 */
export const PRICING_VERIFIED_AT = "2026-09-25";

interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Minimum prompt length that can be cached. */
  minCacheableTokens: number;
}

const PRICES: Record<string, ModelPrice> = {
  "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10, minCacheableTokens: 1024 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5, minCacheableTokens: 4096 },
  "claude-haiku-4-5-20251001": { inputPerMTok: 1, outputPerMTok: 5, minCacheableTokens: 4096 },
};

const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

export function modelPrice(model: string): ModelPrice {
  const price = PRICES[model];
  if (!price) {
    throw new Error(
      `no pricing for model "${model}": add it to src/ai/pricing.ts (verified prices) before using it`,
    );
  }
  return price;
}

export function isPricedModel(model: string): boolean {
  return model in PRICES;
}

/**
 * Cost of a call. The Anthropic API reports `input_tokens` EXCLUDING cache reads and
 * writes, so each bucket is billed separately.
 */
export function costUsd(model: string, usage: TokenUsage): number {
  const p = modelPrice(model);
  const input =
    usage.inputTokens * p.inputPerMTok +
    usage.cacheWriteTokens * p.inputPerMTok * CACHE_WRITE_MULTIPLIER +
    usage.cacheReadTokens * p.inputPerMTok * CACHE_READ_MULTIPLIER;
  return (input + usage.outputTokens * p.outputPerMTok) / 1_000_000;
}

/** Visual tokens of an image: ceil(w/28) * ceil(h/28), capped (high-res tier: 4784). */
export function imageTokens(width: number, height: number): number {
  return Math.min(Math.ceil(width / 28) * Math.ceil(height / 28), 4784);
}

/** Reads width/height from PNG/JPEG headers; null when unknown (caller assumes the cap). */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = b[i + 1] ?? 0;
      const length = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      }
      i += 2 + length;
    }
  }
  return null;
}

/** Rough PDF page count (counts /Type /Page objects); at least 1. */
export function pdfPageCount(bytes: Uint8Array): number {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  return Math.max(1, (text.match(/\/Type\s*\/Page(?!s)/g) ?? []).length);
}

/**
 * Conservative input-token estimate for the budget check (before calling):
 * text ≈ chars / 3; image = visual tokens; PDF page ≈ 3,000 text + 1,600 image tokens.
 */
export function estimateInputTokens(system: string, content: LlmContent[]): number {
  let tokens = Math.ceil(system.length / 3);
  for (const block of content) {
    if (block.type === "text") tokens += Math.ceil(block.text.length / 3);
    else if (block.type === "image") {
      const dims = imageDimensions(block.data);
      tokens += dims ? imageTokens(dims.width, dims.height) : 4784;
    } else tokens += pdfPageCount(block.data) * 4_600;
  }
  return tokens;
}

/** Worst-case cost of a call: estimated input (no cache discount) + max output. */
export function estimateMaxCostUsd(
  model: string,
  estimatedInputTokens: number,
  maxOutputTokens: number,
): number {
  const p = modelPrice(model);
  return (estimatedInputTokens * p.inputPerMTok + maxOutputTokens * p.outputPerMTok) / 1_000_000;
}
