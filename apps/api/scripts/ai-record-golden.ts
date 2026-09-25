/**
 * ai:record-golden — records REAL Claude outputs as golden files for the fake provider
 * (tests, CI and the keyless demo), for the extraction test data.
 *
 *   pnpm --filter @smartops/api ai:record-golden --dry-run          # FREE: exact input tokens + cost estimate
 *   pnpm --filter @smartops/api ai:record-golden --confirm-spend    # SPENDS real credits (asks nothing else)
 *
 * The real run goes through the same AiClient as production: budget guard + ai_usages
 * ledger (counts against AI_TOTAL_BUDGET_USD). Outputs are written UNMODIFIED to
 * <AI_FAKE_GOLDEN_DIR>/<task>/<contentKey>.json and printed for human review.
 * The --dry-run uses the free count_tokens endpoint (no credits).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { createAiClient } from "../src/ai/ai.client.js";
import type { StructuredRequest } from "../src/ai/llm-provider.js";
import { costUsd, modelPrice } from "../src/ai/pricing.js";
import { loadPrompt } from "../src/ai/prompts.js";
import {
  buildAnthropicMessageParams,
  createAnthropicProvider,
} from "../src/ai/providers/anthropic.js";
import { fakeContentKey } from "../src/ai/providers/fake.js";
import { createAiUsageRepository } from "../src/ai/usage.repository.js";
import { createPrismaClient } from "../src/common/db.js";
import { createLogger } from "../src/common/logger.js";
import { loadEnv } from "../src/config/env.js";
import {
  buildCatalogContext,
  type CatalogProduct,
} from "../src/modules/extraction/catalog-context.js";
import {
  classificationJsonSchema,
  classificationSchema,
  extractionJsonSchema,
  extractionSchema,
  type ExtractionOutput,
} from "../src/modules/extraction/extraction.schemas.js";
import {
  buildClassificationContent,
  buildExtractionContent,
  type MessageForAi,
} from "../src/modules/extraction/message-input.js";

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    "confirm-spend": { type: "boolean", default: false },
  },
});
const env = loadEnv();
const logger = createLogger(env);
if (values["dry-run"] === values["confirm-spend"]) {
  logger.error("pass exactly one of --dry-run (free) or --confirm-spend (spends credits)");
  process.exit(1);
}
if (!env.ANTHROPIC_API_KEY) {
  logger.error("ANTHROPIC_API_KEY is required (apps/api/.env)");
  process.exit(1);
}

const fixtures = new URL("../test/fixtures/extraction/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, fixtures));
const PDF = read("lista-prueba.pdf");
const PHOTO = read("lista-precios-foto.jpg");
const TRANSCRIPT = read("voice-transcript.txt").toString("utf8").trim();
const INJECTION = read("injection-message.txt").toString("utf8").trim();
const TEXT = "Lista septiembre: tornillo 6mm 12 UYU, tuerca 6mm 5 UYU"; // real WhatsApp fixture text

const classifier = loadPrompt("classifier");
const extractor = loadPrompt("extractor");

/** Products as the catalog ingest (M4) creates them from an extraction. */
function catalogFrom(output: ExtractionOutput): CatalogProduct[] {
  return output.items.flatMap((item, i) =>
    item.price === null
      ? [] // a percentage change creates no product
      : [
          {
            id: `golden-${String(i + 1).padStart(3, "0")}`,
            name: item.name,
            unit: item.unit,
            price: item.price,
            currency: item.currency ?? output.currency ?? "UYU",
            available: item.available ?? true,
          },
        ],
  );
}

/** Estimate used by --dry-run before the PDF output exists (its 7 lines). */
const SEPTEMBER_ESTIMATE: CatalogProduct[] = [
  ["Tornillo 6mm", "unidad", "12"],
  ["Tuerca 6mm", "unidad", "5"],
  ["Arandela 6mm", "unidad", "3"],
  ["Cable 2mm", "metro", "45"],
  ["Lampara LED 9W", "unidad", "120"],
  ["Pintura latex blanca 4L", "lata", "1850"],
  ["Cemento portland 25kg", "bolsa", "420"],
].map(([name, unit, price], i) => ({
  id: `e${i}`,
  name: name!,
  unit: unit!,
  price: price!,
  currency: "UYU",
  available: true,
}));

const unknownSender = { contactKind: "unknown", supplierName: null };
const supplierSender = (name: string | null) => ({
  contactKind: "supplier",
  supplierName: name ?? "Distribuidora Demo S.A.",
});

type Scenario = {
  label: string;
  expectedOutputTokens: number;
  build: (prev: Map<string, ExtractionOutput>) => StructuredRequest<unknown>;
  save?: string;
};

function msg(partial: Partial<MessageForAi> & Pick<MessageForAi, "messageType">): MessageForAi {
  return {
    text: null,
    transcript: null,
    filename: null,
    mimeType: null,
    media: null,
    ...unknownSender,
    ...partial,
  };
}

function classifyReq(message: MessageForAi): StructuredRequest<unknown> {
  const content = buildClassificationContent(message);
  if (!content.ok) throw new Error(`cannot build classification content: ${content.reason}`);
  return {
    task: "classify",
    model: env.AI_CLASSIFIER_MODEL,
    system: classifier.text,
    cacheSystem: env.AI_PROMPT_CACHE,
    content: content.content,
    jsonSchema: classificationJsonSchema as unknown as Record<string, unknown>,
    schema: classificationSchema,
    effort: "low",
    maxTokens: 1024,
  };
}

function extractReq(message: MessageForAi, catalog: CatalogProduct[]): StructuredRequest<unknown> {
  const content = buildExtractionContent(message, buildCatalogContext(catalog).text);
  if (!content.ok) throw new Error(`cannot build extraction content: ${content.reason}`);
  return {
    task: "extract",
    model: env.AI_EXTRACTOR_MODEL,
    system: extractor.text,
    cacheSystem: env.AI_PROMPT_CACHE,
    content: content.content,
    jsonSchema: extractionJsonSchema as unknown as Record<string, unknown>,
    schema: extractionSchema,
    effort: "medium",
    maxTokens: 6000,
  };
}

const september = (prev: Map<string, ExtractionOutput>) => {
  const pdf = prev.get("pdf");
  return {
    catalog: pdf ? catalogFrom(pdf) : SEPTEMBER_ESTIMATE,
    supplier: supplierSender(pdf?.supplierName ?? null),
  };
};

const scenarios: Scenario[] = [
  {
    label: "classify: WhatsApp text with prices",
    expectedOutputTokens: 250,
    build: () => classifyReq(msg({ messageType: "text", text: TEXT })),
  },
  {
    label: "classify: voice transcript (ASR error)",
    expectedOutputTokens: 250,
    build: () => classifyReq(msg({ messageType: "audio", transcript: TRANSCRIPT })),
  },
  {
    label: "classify: prompt-injection text",
    expectedOutputTokens: 300,
    build: () => classifyReq(msg({ messageType: "text", text: INJECTION })),
  },
  {
    label: "extract: September PDF (empty catalog)",
    expectedOutputTokens: 2200,
    save: "pdf",
    build: () =>
      extractReq(
        msg({
          messageType: "document",
          mimeType: "application/pdf",
          filename: "lista-prueba.pdf",
          media: PDF,
        }),
        [],
      ),
  },
  {
    label: "extract: October photo (catalog = September)",
    expectedOutputTokens: 2200,
    build: (prev) => {
      const s = september(prev);
      return extractReq(
        msg({ messageType: "image", mimeType: "image/jpeg", media: PHOTO, ...s.supplier }),
        s.catalog,
      );
    },
  },
  {
    label: "extract: voice transcript (catalog = September)",
    expectedOutputTokens: 900,
    build: (prev) => {
      const s = september(prev);
      return extractReq(
        msg({ messageType: "audio", transcript: TRANSCRIPT, ...s.supplier }),
        s.catalog,
      );
    },
  },
  {
    label: "extract: prompt-injection text (catalog = September)",
    expectedOutputTokens: 1000,
    build: (prev) => {
      const s = september(prev);
      return extractReq(msg({ messageType: "text", text: INJECTION, ...s.supplier }), s.catalog);
    },
  },
];

const fmt = (usd: number) => `$${usd.toFixed(4)}`;

if (values["dry-run"]) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 30_000 });
  let totalExpected = 0;
  let totalWorst = 0;
  const rows: string[] = [];
  for (const scenario of scenarios) {
    const request = scenario.build(new Map());
    const full = buildAnthropicMessageParams(request);
    // count_tokens takes the same parameters minus max_tokens.
    const params = {
      model: full.model,
      system: full.system,
      messages: full.messages,
      output_config: full.output_config,
    };
    const counted = await client.messages.countTokens(params); // FREE endpoint
    const price = modelPrice(request.model);
    const expected = costUsd(request.model, {
      inputTokens: counted.input_tokens,
      outputTokens: scenario.expectedOutputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    const worst =
      (counted.input_tokens * price.inputPerMTok + request.maxTokens * price.outputPerMTok) / 1e6;
    totalExpected += expected;
    totalWorst += worst;
    rows.push(
      `${scenario.label.padEnd(52)} in=${String(counted.input_tokens).padStart(5)}  out≈${String(scenario.expectedOutputTokens).padStart(5)}  expected=${fmt(expected)}  worst=${fmt(worst)}`,
    );
  }
  process.stdout.write(
    `\nDRY RUN (count_tokens is free; nothing was spent)\nmodel: ${env.AI_EXTRACTOR_MODEL} / ${env.AI_CLASSIFIER_MODEL}\n\n${rows.join("\n")}\n\nTOTAL expected ${fmt(totalExpected)}   worst case ${fmt(totalWorst)}\n`,
  );
  process.exit(0);
}

// ─── Real recording (spends credits) ────────────────────────────────────────
const prisma = createPrismaClient(env.DATABASE_URL, logger);
const ai = createAiClient({
  provider: createAnthropicProvider({
    apiKey: env.ANTHROPIC_API_KEY,
    timeoutMs: env.AI_TIMEOUT_MS,
  }),
  usage: createAiUsageRepository(prisma),
  limits: {
    totalUsd: env.AI_TOTAL_BUDGET_USD,
    dailyUsd: env.AI_DAILY_BUDGET_USD,
    dailyExtractionsPerContact: env.AI_DAILY_LIMIT_PER_CONTACT,
  },
});
const goldenDir = resolve(env.AI_FAKE_GOLDEN_DIR);
const prev = new Map<string, ExtractionOutput>();
let total = 0;
try {
  for (const scenario of scenarios) {
    const request = scenario.build(prev);
    const result = await ai.generateStructured(request, {
      promptVersion: request.task === "classify" ? classifier.version : extractor.version,
      log: logger,
    });
    total += result.costUsd;
    const key = fakeContentKey(request.task, request.content);
    const dir = join(goldenDir, request.task);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${key}.json`), `${JSON.stringify(result.data, null, 2)}\n`);
    if (scenario.save) prev.set(scenario.save, result.data as ExtractionOutput);
    process.stdout.write(
      `\n=== ${scenario.label}  (${fmt(result.costUsd)}, in=${result.usage.inputTokens} out=${result.usage.outputTokens} cacheR=${result.usage.cacheReadTokens} cacheW=${result.usage.cacheWriteTokens}, ${result.latencyMs} ms)\n${JSON.stringify(result.data, null, 2)}\n`,
    );
  }
  process.stdout.write(`\nTOTAL spent ${fmt(total)} — golden files in ${goldenDir}\n`);
} finally {
  await prisma.$disconnect();
}
