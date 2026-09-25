import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

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
