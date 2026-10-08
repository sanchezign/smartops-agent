/**
 * The demo CONTENT as data (phase 14 M5a, ADR-031): everything the demo seed and the "Try the
 * system" buttons show that depends on the language of the business — who the suppliers are, what
 * they sell, what customers write, the texts of the seed. One module per language
 * (content/es.ts, content/en.ts); DEMO_CONTENT_LANGUAGE picks one per deployment. The seed code
 * only walks this structure, so both languages tell the SAME story (same shape: a price rise that
 * alerts, an outlier, a doubtful voice value, a global change, a product missing from a full list,
 * a currency change, a prompt-injection message, a new spreadsheet format…).
 */

export type DemoLanguage = "en" | "es";
export const DEMO_LANGUAGES: readonly DemoLanguage[] = ["en", "es"];

export interface DemoProduct {
  name: string;
  unit: string;
  price: number;
  stock?: number;
}

export interface DemoSupplier {
  key: string;
  name: string;
  waId: string;
  contactName: string;
  taxIncluded: boolean;
  /** Currency this supplier quotes in (ISO 4217). */
  currency: string;
  products: DemoProduct[];
}

export interface DemoCustomer {
  waId: string;
  name: string;
  kind: "customer" | "internal";
}

/** Who sends the samples of "Try the system". The keys are language-neutral. */
export type DemoSampleSenderKey = "catalog" | "known" | "unknown";
export interface DemoSampleSender {
  waId: string;
  contactName: string;
  supplierName: string;
}

export const DEMO_SAMPLE_KINDS = [
  "foto",
  "pdf",
  "audio",
  "planilla",
  "planilla_nueva",
  "injection",
] as const;
export type DemoSampleKind = (typeof DEMO_SAMPLE_KINDS)[number];

/** One button of "Try the system": what the (simulated) WhatsApp message carries. */
export interface DemoSample {
  sender: DemoSampleSenderKey;
  type: "text" | "image" | "document" | "audio";
  /** A file of the language's assets folder. For `type: "text"` its content is the message. */
  file: string;
  mimeType?: string;
  filename?: string | null;
  voice?: boolean;
}

export interface DemoSheet {
  name: string;
  rows: (string | number | null)[][];
}

/** The mapper's canned answer for the new-format sheet (same shape as its golden output). */
export interface DemoSheetMapper {
  table: string;
  isPriceTable: boolean;
  headerRow: number;
  nameColumn: number;
  unitColumn: number | null;
  skuColumn: number | null;
  currencyColumn: number | null;
  stockColumn: number | null;
  availableColumn: number | null;
  pctColumn: number | null;
  priceColumns: {
    column: number;
    header: string;
    taxIncluded: boolean | null;
    kind: "list" | "wholesale" | "cash" | "card" | "cost" | "other";
  }[];
  recommendedPriceColumn: number;
  priceFormat: "decimal_dot" | "decimal_comma";
  currency: string;
  confidence: "high" | "medium" | "low";
}

/** The recent events that put work in front of a person (the review queue of the demo). */
export interface DemoStory {
  /** Supplier 0, 5 days ago: increases incl. one over the alert threshold and an outlier. */
  increases: {
    message: string;
    photoCaption: string;
    rises: { product: string; factor: number }[];
    /** A line the planner cannot match with certainty: it asks a person (catalogRef P<n>). */
    alias: { name: string; product: string; ref: string };
  };
  /** Supplier 1, 3 days ago: a global percentage and a doubtful value from a voice note. */
  globalChange: { message: string; product: string; factor: number; note: string; pct: string };
  /** Supplier 2, 4 days ago: a FULL list without one product (asks before marking it unavailable). */
  missingFromList: { message: string; product: string; evidence: string };
  /** Supplier 2, 2 days ago: one product quoted in ANOTHER currency + a new product. */
  currencyChange: {
    message: string;
    changed: { name: string; price: number; currency: string };
    created: { name: string; price: number };
  };
  /** Supplier 0, yesterday: a message that tries to give orders to the bot. */
  injection: { message: string; product: string; price: number };
}

/** Texts of the seed (what the people and the system "wrote"). */
export interface DemoTexts {
  fullListMessage(supplierName: string): string;
  fullListEvidence: string;
  updateMessage(count: number): string;
  thanksReply(count: number): string;
  suspiciousDetail: string;
  /** "Order from X: …" / "Query from X: …" (panel notification title). */
  itemTitle(kind: "order" | "customer_query", name: string, text: string): string;
  humanReply: string;
  botCanceledReply: string;
  optOut: { keyword: string; consentKeyword: string; confirmation: string };
  audioAlertTitle: string;
  integrationAlertTitle: string;
}

export interface DemoContent {
  language: DemoLanguage;
  /** Subfolder of DEMO_ASSETS_DIR/assets with this language's sample files ("" = the root). */
  assetsSubdir: string;
  /** Currency of the sample senders' lists (the suppliers carry their own). */
  currency: string;
  suppliers: [DemoSupplier, DemoSupplier, DemoSupplier];
  customers: DemoCustomer[];
  /** [customer index, text, kind, days ago] */
  customerMessages: [number, string, "query" | "order", number][];
  /** Index of the customer a person is handling right now / who asked to stop (opt-out). */
  humanCustomer: number;
  optOutCustomer: number;
  chitchat: string[];
  /** The fake team number the seeded digests go to (nothing is ever sent). */
  teamWaId: string;
  sampleSenders: Record<DemoSampleSenderKey, DemoSampleSender>;
  samples: Record<DemoSampleKind, DemoSample>;
  /** Supplier 0's spreadsheet in a format never approved (the column_mapping review). */
  sheet: DemoSheet;
  sheetMapper: DemoSheetMapper;
  sheetFilename: string;
  sheetCaption: string;
  sheetProposal: { supplierName: string; warnings: string[] };
  /** The recorded mapper answer to use: the one whose supplierName is this. */
  mapperGoldenSupplierName: string;
  /** The "known sender": a list in its approved format (the spreadsheet fast path, $0). */
  knownSender: {
    messageText: string;
    evidence: string;
    /** The approved format is learned from this asset spreadsheet. */
    formatFile: string;
    /** Lines of its earlier list (the catalog the sample spreadsheets are compared with). */
    earlierList: [string, string, number][];
    /**
     * The approved format, as data. Absent → the seed reads the recorded mapper answer (golden)
     * of `mapperGoldenSupplierName` (the Spanish content).
     */
    formatMapper?: DemoSheetMapper;
  };
  catalogListMessage: string;
  /**
   * The sample catalog sender's September list, as data [name, unit, price]. Absent → the seed
   * reads the recorded PDF extraction (golden) of that sender (the Spanish content). A test
   * checks that the recorded answer, once it exists, says the same.
   */
  catalogSender?: { evidence: string; list: [string, string, number][] };
  story: DemoStory;
  text: DemoTexts;
  /** E2E only: a supplier per Playwright project with two products to approve / reject. */
  e2e: {
    supplierName(project: string): string;
    waId(index: number): string;
    products(project: string): [string, string];
    initialMessage: string;
    raiseMessage: string;
  };
}
