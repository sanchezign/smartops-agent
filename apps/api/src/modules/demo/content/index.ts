import { ES_CONTENT } from "./es.js";
import type { DemoContent, DemoLanguage } from "./types.js";

export type { DemoContent, DemoLanguage } from "./types.js";
export { DEMO_LANGUAGES, DEMO_SAMPLE_KINDS } from "./types.js";
export type { DemoSampleKind } from "./types.js";

/** The demo content of a language (DEMO_CONTENT_LANGUAGE picks it per deployment, ADR-031). */
export function getDemoContent(language: DemoLanguage): DemoContent {
  if (language === "es") return ES_CONTENT;
  throw new Error(`demo content "${language}" is not available yet`);
}
