import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

/**
 * E2E environment (phase 9): its own database `<dev db>_e2e_demo` (the demo seed only accepts
 * names ending in "_demo"), the API on :4100 and the panel on :3100 — never the developer's
 * running `pnpm dev` (:4000 / :3000) nor the development data.
 */
// Resolved from the admin package root (Playwright runs with cwd = apps/admin).
const apiEnv = parseEnv(readFileSync(resolve(process.cwd(), "../api/.env"), "utf8"));
const devUrl = new URL(process.env.E2E_BASE_DATABASE_URL ?? apiEnv.DATABASE_URL ?? "");

const e2eUrl = new URL(devUrl);
e2eUrl.pathname = `${devUrl.pathname.replace(/\/+$/, "")}_e2e_demo`;

export const E2E = {
  databaseUrl: e2eUrl.toString(),
  apiPort: 4100,
  panelPort: 3100,
  panelUrl: "http://localhost:3100",
  operator: { email: "demo@ferreteria.demo", password: "probá el panel sin miedo" },
  admin: {
    email: "admin@ferreteria.demo",
    password: "clave de administración para las pruebas e2e",
  },
} as const;
