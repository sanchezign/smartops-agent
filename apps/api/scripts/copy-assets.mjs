// Copies non-TypeScript runtime assets from src/ to dist/ after `tsc` (which only emits
// .js). Today: every `prompts/` directory (versioned prompt files, e.g.
// src/modules/transcription/prompts/*.md, and src/ai/prompts/*.md in phase 5).
import { cpSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = join(root, "src");
const dist = join(root, "dist");

function copyPromptDirs(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (!statSync(path).isDirectory() || entry === "generated") continue;
    if (entry === "prompts") {
      const target = join(dist, relative(src, path));
      cpSync(path, target, { recursive: true });
      process.stdout.write(`copied ${relative(root, path)} -> ${relative(root, target)}\n`);
    } else {
      copyPromptDirs(path);
    }
  }
}

copyPromptDirs(src);
