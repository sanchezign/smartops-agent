import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { BusinessLanguage } from "../common/business-texts.js";

/**
 * Versioned prompt files (src/ai/prompts/*.md, copied to dist by
 * scripts/copy-assets.mjs). The version is a short hash of the file content, stored in
 * every ai_usages / ingestion_runs row so results can be traced to the exact prompt.
 */

export interface LoadedPrompt {
  name: string;
  text: string;
  version: string;
}

const PROMPTS_DIR = new URL("./prompts/", import.meta.url);

export function loadPrompt(name: string, dir: URL = PROMPTS_DIR): LoadedPrompt {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`invalid prompt name "${name}"`);
  const text = readFileSync(new URL(`${name}.md`, dir), "utf8").trim();
  if (text.length === 0) throw new Error(`prompt "${name}" is empty`);
  const version = `${name}@${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;
  return { name, text, version };
}

const BLOCKS = new Map<string, LoadedPrompt>();

/**
 * The prompt for a BUSINESS LANGUAGE (phase 14 M5b, ADR-031). Spanish is the base prompt,
 * byte for byte (same text, same version): nothing changes for a Spanish business. Another language
 * APPENDS one block (`language-<lang>.md`) at the end: the base text is never edited or reordered, so
 * the security rules of the prompt stay exactly where and as they were, and the block itself restates
 * that data is data in every language.
 */
export function promptForLanguage(
  prompt: LoadedPrompt,
  language: BusinessLanguage,
  dir: URL = PROMPTS_DIR,
): LoadedPrompt {
  if (language === "es") return prompt;
  const key = `${dir.href}${language}`;
  let block = BLOCKS.get(key);
  if (!block) {
    block = loadPrompt(`language-${language}`, dir);
    BLOCKS.set(key, block);
  }
  const text = `${prompt.text}\n\n${block.text}`;
  const version = `${prompt.name}@${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;
  return { name: prompt.name, text, version };
}
