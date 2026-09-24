import { existsSync } from "node:fs";
import { defineConfig } from "prisma/config";

// Prisma 7 does not load .env automatically. Load it with Node's built-in loader
// when present (local dev); in CI/Render the vars come from the environment.
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Optional for `prisma generate`; required by `migrate`/`studio`.
    // Not using env() from prisma/config because it throws when the var is
    // missing, which would break `prisma generate` in CI without a database.
    url: process.env.DATABASE_URL,
  },
});
