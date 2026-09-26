/**
 * demo:seed — (re)creates the DEMO database with 90 days of realistic activity (phase 9).
 * It only ever touches DEMO_DATABASE_URL, whose database name must end in "_demo": the
 * development database (DATABASE_URL) and real data are never read or written.
 *
 *   pnpm --filter @smartops/api demo:seed
 *
 * Creates the database if missing, applies migrations (prisma migrate deploy), wipes it and
 * seeds it. Users: the demo operator (public credentials, env DEMO_OPERATOR_*) and, only if
 * DEMO_ADMIN_PASSWORD is set, a demo admin. To run the API / panel on it, start them with
 * DATABASE_URL=$DEMO_DATABASE_URL.
 */
import { execSync } from "node:child_process";
import pg from "pg";
import { createPrismaClient } from "../../src/common/db.js";
import { createLogger } from "../../src/common/logger.js";
import { loadEnv } from "../../src/config/env.js";
import { createCatalogIngestService } from "../../src/modules/catalog/catalog-ingest.service.js";
import { createCatalogRepository } from "../../src/modules/catalog/catalog.repository.js";
import { assertDemoDatabaseName, seedDemo } from "../../src/modules/demo/demo-seed.js";
import {
  createSettingsRepository,
  createSettingsService,
} from "../../src/modules/settings/settings.service.js";

const env = loadEnv();
const logger = createLogger(env);

if (!env.DEMO_DATABASE_URL) {
  process.stderr.write(
    "Set DEMO_DATABASE_URL in apps/api/.env (a database whose name ends in _demo)\n",
  );
  process.exit(1);
}
const url = new URL(env.DEMO_DATABASE_URL);
const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
// The only guarantee needed: the target is a *_demo database (the API may run on it too).
assertDemoDatabaseName(name);

const adminUrl = new URL(url);
adminUrl.pathname = "/postgres";
const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
try {
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
} finally {
  await admin.end();
}
execSync("pnpm exec prisma migrate deploy", {
  cwd: new URL("../../", import.meta.url),
  env: { ...process.env, DATABASE_URL: env.DEMO_DATABASE_URL },
  stdio: "pipe",
});

const prisma = createPrismaClient(env.DEMO_DATABASE_URL, logger);
try {
  const settings = createSettingsService({ repository: createSettingsRepository(prisma) });
  const result = await seedDemo({
    prisma,
    catalog: createCatalogIngestService({ repository: createCatalogRepository(prisma), settings }),
    users: {
      operator: {
        email: env.DEMO_OPERATOR_EMAIL,
        password: env.DEMO_OPERATOR_PASSWORD,
        name: "Operador demo",
      },
      ...(env.DEMO_ADMIN_PASSWORD
        ? {
            admin: {
              email: env.DEMO_ADMIN_EMAIL,
              password: env.DEMO_ADMIN_PASSWORD,
              name: "Admin demo",
            },
          }
        : {}),
    },
    logger,
  });
  process.stdout.write(`demo seeded: ${JSON.stringify(result)}\n`);
} finally {
  await prisma.$disconnect();
}
