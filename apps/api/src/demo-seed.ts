/**
 * Production entry of the demo seed (phase 12): `node dist/demo-seed.js`, run by
 * deploy/bin/deploy.sh after the migrations (compose service "seed"). The production image
 * carries no scripts/, and a fresh public demo would otherwise have no data and no public
 * operator to log in with.
 *
 * DEMO_MODE only — the env module already refuses DEMO_MODE on a database whose name does not
 * end in "_demo", and seedDemo checks it again. Users and live sessions are kept (visitors stay
 * logged in across deploys); everything else is rebuilt, exactly like the hourly reset.
 */
import { createPrismaClient } from "./common/db.js";
import { getDemoContent } from "./modules/demo/content/index.js";
import { createLogger } from "./common/logger.js";
import { loadEnv } from "./config/env.js";
import { createCatalogIngestService } from "./modules/catalog/catalog-ingest.service.js";
import { createCatalogRepository } from "./modules/catalog/catalog.repository.js";
import { seedDemo } from "./modules/demo/demo-seed.js";
import {
  createSettingsRepository,
  createSettingsService,
} from "./modules/settings/settings.service.js";

const env = loadEnv();
const logger = createLogger(env);

if (!env.DEMO_MODE) {
  logger.fatal("demo-seed only runs with DEMO_MODE=true (it wipes and refills the database)");
  process.exit(1);
}

const prisma = createPrismaClient(env.DATABASE_URL, logger);
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
      // The public demo has no admin (env.ts refuses DEMO_ADMIN_PASSWORD there in production).
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
    keepAuth: true,
    assetsDir: env.DEMO_ASSETS_DIR,
    content: getDemoContent(env.DEMO_CONTENT_LANGUAGE),
    e2eReviews: env.DEMO_E2E_REVIEWS,
  });
  logger.info({ result }, "demo seeded");
} finally {
  await prisma.$disconnect();
}
