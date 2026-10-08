/**
 * ai:record-golden — records REAL Claude outputs as golden files for the fake provider
 * (tests, CI and the keyless demo), for the extraction test data.
 *
 *   pnpm --filter @smartops/api ai:record-golden --dry-run          # FREE: exact input tokens + cost estimate
 *   pnpm --filter @smartops/api ai:record-golden --confirm-spend    # SPENDS real credits (asks nothing else)
 *   ... --lang en|es   # which fixtures and which business language (default es; en = phase 14 M5)
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
import type { BusinessLanguage } from "../src/common/business-texts.js";
import type { StructuredRequest } from "../src/ai/llm-provider.js";
import { costUsd, modelPrice } from "../src/ai/pricing.js";
import { loadPrompt, promptForLanguage } from "../src/ai/prompts.js";
import {
  buildAnthropicMessageParams,
  createAnthropicProvider,
} from "../src/ai/providers/anthropic.js";
import { fakeContentKey } from "../src/ai/providers/fake.js";
import { createAiUsageRepository } from "../src/ai/usage.repository.js";
import { convertSpreadsheet } from "../src/modules/documents/converters/spreadsheet.js";
import { DEFAULT_CONVERSION_LIMITS } from "../src/modules/documents/document-types.js";
import { headerCandidates } from "../src/modules/sheets/sheet-extraction.js";
import { buildMapperContent, buildMatcherContent } from "../src/modules/sheets/sheet-input.js";
import {
  mapperJsonSchema,
  mapperOutputSchema,
  matcherJsonSchema,
  matcherOutputSchema,
} from "../src/modules/sheets/sheet-mapping.js";
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
    /** Only scenarios whose label starts with this prefix (e.g. "sheets"). */
    only: { type: "string" },
    /** Business language of the fixtures and of the prompts (ADR-031). */
    lang: { type: "string", default: "es" },
  },
});
if (values.lang !== "es" && values.lang !== "en") {
  process.stderr.write("--lang must be es or en\n");
  process.exit(1);
}
const lang: BusinessLanguage = values.lang;
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

/** What differs per language: the fixtures, the sender, the currency, the catalogs of the scenarios. */
const SETUP = {
  es: {
    dir: "",
    pdf: "lista-prueba.pdf",
    photo: "lista-precios-foto.jpg",
    sheet: "precios-multiples.xlsx",
    text: "Lista septiembre: tornillo 6mm 12 UYU, tuerca 6mm 5 UYU", // real WhatsApp fixture text
    sender: "Distribuidora Demo S.A.",
    currency: "UYU",
    september: [
      ["Tornillo 6mm", "unidad", "12"],
      ["Tuerca 6mm", "unidad", "5"],
      ["Arandela 6mm", "unidad", "3"],
      ["Cable 2mm", "metro", "45"],
      ["Lampara LED 9W", "unidad", "120"],
      ["Pintura latex blanca 4L", "lata", "1850"],
      ["Cemento portland 25kg", "bolsa", "420"],
    ],
    november: [
      ["Candado bronce 40mm", "unidad", "310.5"],
      ["Cerradura de embutir", "unidad", "245"],
      ["Bisagra 3 pulgadas", "unidad", "455"],
      ["Tarugo 8mm x100", "caja", "144"],
      ["Pegamento de contacto 250ml", "lata", "44"],
      ["Cinta aisladora 20m", "rollo", "100"],
      ["Guante de nitrilo talle M", "par", "115"],
    ],
    newRow: { id: "R8", name: "Tanza para bordeadora 2mm", unit: "rollo" },
  },
  en: {
    dir: "en/",
    pdf: "price-list-september.pdf",
    photo: "price-list-october-photo.jpg",
    sheet: "prices-multiple.xlsx",
    text: "September list: 1/4 in hex bolt $0.54, 1/4 in hex nut $0.22",
    sender: "Demo Distributing Inc.",
    currency: "USD",
    september: [
      ["Hex bolt 1/4 in", "each", "0.54"],
      ["Hex nut 1/4 in", "each", "0.22"],
      ["Washer 1/4 in", "each", "0.12"],
      ["Wire 14 AWG", "ft", "0.45"],
      ["LED bulb 9 W", "each", "3.20"],
      ["Interior latex paint, white 1 gal", "gal", "24.50"],
      ["Portland cement 94 lb", "bag", "9.40"],
    ],
    november: [
      ["Brass padlock 1-1/2 in", "each", "11.8"],
      ["Mortise lockset", "each", "14.6"],
      ["Door hinge 3 in", "pair", "5.2"],
      ["Wall anchor 5/16 in (bag of 100)", "bag", "6.9"],
      ["Wood glue 8 oz", "can", "4.4"],
      ["Electrical tape 3/4 in", "roll", "3.1"],
      ["Nitrile gloves, size M", "pair", "1.8"],
    ],
    newRow: { id: "R8", name: "Trimmer line 0.080 in", unit: "spool" },
  },
}[lang];

const fixtures = new URL(`../test/fixtures/extraction/${SETUP.dir}`, import.meta.url);
const read = (name: string) => readFileSync(new URL(name, fixtures));
const PDF = read(SETUP.pdf);
const PHOTO = read(SETUP.photo);
const TRANSCRIPT = read("voice-transcript.txt").toString("utf8").trim();
const INJECTION = read("injection-message.txt").toString("utf8").trim();
const TEXT = SETUP.text;

// The prompts the business language really uses (Spanish = the base prompt, unchanged).
const classifier = promptForLanguage(loadPrompt("classifier"), lang);
const extractor = promptForLanguage(loadPrompt("extractor"), lang);

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
            currency: item.currency ?? output.currency ?? SETUP.currency,
            available: item.available ?? true,
          },
        ],
  );
}

/** Estimate used by --dry-run before the PDF output exists (its 7 lines). */
const SEPTEMBER_ESTIMATE: CatalogProduct[] = SETUP.september.map(([name, unit, price], i) => ({
  id: `e${i}`,
  name: name!,
  unit: unit!,
  price: price!,
  currency: SETUP.currency,
  available: true,
}));

const unknownSender = { contactKind: "unknown", supplierName: null };
const supplierSender = (name: string | null) => ({
  contactKind: "supplier",
  supplierName: name ?? SETUP.sender,
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

// ─── Spreadsheet path (phase 5 M3c) ───
const SHEETS = new URL(`../test/fixtures/sheets/${SETUP.dir}`, import.meta.url);
const sheetTables = (name: string) => {
  const result = convertSpreadsheet(
    readFileSync(new URL(name, SHEETS)),
    "xlsx",
    DEFAULT_CONVERSION_LIMITS,
  );
  if (!result.ok) throw new Error(`cannot convert ${name}: ${result.reason}`);
  return result.tables;
};
const mapper = promptForLanguage(loadPrompt("column-mapper"), lang);
const matcher = promptForLanguage(loadPrompt("matcher"), lang);
const NOVEMBER_CATALOG: CatalogProduct[] = SETUP.november.map(([name, unit, price], i) => ({
  id: `nov-${i}`,
  name: name!,
  unit: unit!,
  price: price!,
  currency: SETUP.currency,
  available: true,
}));

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
          filename: SETUP.pdf,
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
  {
    label: "sheets: map_columns prices-multiple.xlsx (4 price columns)",
    expectedOutputTokens: 450,
    build: () => {
      const tables = sheetTables(SETUP.sheet);
      const indexes = tables
        .map((table, index) => ({ table, index }))
        .filter(({ table }) => headerCandidates(table).length > 0);
      return {
        task: "map_columns",
        model: env.AI_EXTRACTOR_MODEL,
        system: mapper.text,
        cacheSystem: env.AI_PROMPT_CACHE,
        content: buildMapperContent(indexes),
        jsonSchema: mapperJsonSchema as unknown as Record<string, unknown>,
        schema: mapperOutputSchema,
        effort: "low",
        maxTokens: 3000,
      };
    },
  },
  {
    label: "sheets: match december's new rows vs november catalog",
    expectedOutputTokens: 80,
    build: () => {
      const catalog = buildCatalogContext(NOVEMBER_CATALOG);
      return {
        task: "match",
        model: env.AI_EXTRACTOR_MODEL,
        system: matcher.text,
        cacheSystem: env.AI_PROMPT_CACHE,
        content: buildMatcherContent([SETUP.newRow], catalog.text ?? ""),
        jsonSchema: matcherJsonSchema as unknown as Record<string, unknown>,
        schema: matcherOutputSchema,
        effort: "low",
        maxTokens: 6000,
      };
    },
  },
];

const selected = values.only
  ? scenarios.filter((sc) => sc.label.startsWith(values.only ?? ""))
  : scenarios;
if (selected.length === 0) {
  logger.error({ only: values.only }, "no scenario matches --only");
  process.exit(1);
}

const fmt = (usd: number) => `${usd.toFixed(4)}`;

if (values["dry-run"]) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 30_000 });
  let totalExpected = 0;
  let totalWorst = 0;
  const rows: string[] = [];
  for (const scenario of selected) {
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
    runUsd: env.AI_MAX_RUN_USD,
  },
});
const goldenDir = resolve(env.AI_FAKE_GOLDEN_DIR);
const prev = new Map<string, ExtractionOutput>();
let total = 0;
try {
  for (const scenario of selected) {
    const request = scenario.build(prev);
    const result = await ai.generateStructured(request, {
      promptVersion: {
        classify: classifier.version,
        extract: extractor.version,
        map_columns: mapper.version,
        match: matcher.version,
      }[request.task],
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
