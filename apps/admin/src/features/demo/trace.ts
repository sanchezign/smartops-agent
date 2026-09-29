/**
 * "Try the system" timeline (phase 9 M8): where an injected sample is in the REAL pipeline,
 * from GET /api/v1/demo/trace/:wamid. Pure — unit tested. Returns message keys of "demo.steps",
 * "demo.outcomes" and "demo.links" (phase 13); the page translates them.
 */

export type DemoSampleKind = "foto" | "pdf" | "audio" | "planilla" | "planilla_nueva" | "injection";

export interface DemoTrace {
  received: boolean;
  message?: { id: string; conversationId: string; type: string };
  media?: { status: string; transcription: string | null; conversion: string | null } | null;
  run?: {
    id: string;
    status: string;
    classification: string | null;
    prefilterRule: string | null;
    reason: string | null;
    priceChanges: number;
    createdProducts: number;
    pendingReviews: number;
  } | null;
}

export type StepKey =
  "received" | "downloaded" | "transcribed" | "sheetRead" | "classified" | "extracted" | "held";

export interface TimelineStep {
  key: StepKey;
  /** held = stopped ON PURPOSE for a person (amber); failed = a real failure (red). */
  state: "done" | "active" | "waiting" | "held" | "failed";
}

export type OutcomeKey = "suspicious" | "newFormat" | "review" | "updated" | "noChanges" | "failed";
export type LinkKey = "viewReviews" | "pickColumn" | "viewCatalog" | "viewConversation";

export interface TimelineOutcome {
  key: OutcomeKey;
  /** For "updated": what changed (only the non-zero counts are shown). */
  counts?: { prices: number; created: number; reviews: number };
  tone: "success" | "review" | "failed";
  /** Panel screen to see it. */
  href: string;
  linkKey: LinkKey;
}

const FINAL_RUN = new Set(["ingested", "needs_review", "failed", "rejected"]);

export function timeline(
  kind: DemoSampleKind,
  trace: DemoTrace | null,
): {
  steps: TimelineStep[];
  outcome: TimelineOutcome | null;
  finished: boolean;
} {
  const steps: TimelineStep[] = [];
  const add = (key: StepKey, done: boolean) => {
    const previousDone = steps.every((s) => s.state === "done");
    steps.push({ key, state: done ? "done" : previousDone ? "active" : "waiting" });
  };
  const run = trace?.run ?? null;
  const media = trace?.media ?? null;

  add("received", Boolean(trace?.received));
  if (kind !== "injection") add("downloaded", media?.status === "stored");
  if (kind === "audio") add("transcribed", media?.transcription === "done");
  if (kind === "planilla" || kind === "planilla_nueva")
    add("sheetRead", media?.conversion === "done");
  add("classified", Boolean(run && run.status !== "pending"));
  add("extracted", Boolean(run && FINAL_RUN.has(run.status)));

  if (!run || !FINAL_RUN.has(run.status) || !trace?.message) {
    return { steps, outcome: null, finished: false };
  }
  const conversation = `/conversations/${trace.message.conversationId}`;
  if (run.status === "needs_review") {
    const last = steps.at(-1)!;
    last.state = "held";
    last.key = "held";
    if (run.reason === "suspicious_instructions") {
      return {
        steps,
        finished: true,
        outcome: {
          key: "suspicious",
          tone: "review",
          href: "/reviews",
          linkKey: "viewReviews",
        },
      };
    }
    if (run.reason === "column_mapping_required" || run.reason === "sheet_format_changed") {
      return {
        steps,
        finished: true,
        outcome: {
          key: "newFormat",
          tone: "review",
          href: "/reviews",
          linkKey: "pickColumn",
        },
      };
    }
    return {
      steps,
      finished: true,
      outcome: {
        key: "review",
        tone: "review",
        href: "/reviews",
        linkKey: "viewReviews",
      },
    };
  }
  if (run.status === "ingested") {
    const counts = {
      prices: run.priceChanges,
      created: run.createdProducts,
      reviews: run.pendingReviews,
    };
    const changed = counts.prices + counts.created + counts.reviews > 0;
    return {
      steps,
      finished: true,
      outcome: {
        key: changed ? "updated" : "noChanges",
        ...(changed ? { counts } : {}),
        tone: run.pendingReviews > 0 ? "review" : "success",
        href: run.pendingReviews > 0 ? "/reviews" : "/catalog",
        linkKey: run.pendingReviews > 0 ? "viewReviews" : "viewCatalog",
      },
    };
  }
  steps.at(-1)!.state = "failed";
  return {
    steps,
    finished: true,
    outcome: {
      key: "failed",
      tone: "failed",
      href: conversation,
      linkKey: "viewConversation",
    },
  };
}
