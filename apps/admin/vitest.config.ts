import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Coverage ratchet (phase 10): measured − 2, only goes up (scripts/coverage-ratchet.mjs). */
const ratchet = JSON.parse(
  readFileSync(new URL("./coverage-thresholds.json", import.meta.url), "utf8"),
) as { global: Record<string, number> };

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      // The panel LOGIC: lib + pure feature modules. Components, hooks and stores are covered
      // by the browser E2E (no React Testing Library, user decision phase 10).
      include: ["src/lib/**/*.ts", "src/features/**/*.ts", "src/i18n/locales.ts"],
      exclude: ["**/hooks.ts", "**/store.ts", "**/types.ts", "src/features/auth/api.ts"],
      reporter: ["text-summary", "json-summary", "html"],
      thresholds: ratchet.global,
    },
  },
});
