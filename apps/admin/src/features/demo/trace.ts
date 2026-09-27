/**
 * "Probar el sistema" timeline (phase 9 M8): where an injected sample is in the REAL pipeline,
 * from GET /api/v1/demo/trace/:wamid. Pure — unit tested.
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

export interface TimelineStep {
  label: string;
  state: "done" | "active" | "waiting" | "stopped";
}

export interface TimelineOutcome {
  text: string;
  tone: "success" | "review" | "stopped";
  /** Panel screen to see it. */
  href: string;
  linkText: string;
}

const FINAL_RUN = new Set(["ingested", "needs_review", "failed", "rejected"]);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function timeline(
  kind: DemoSampleKind,
  trace: DemoTrace | null,
): {
  steps: TimelineStep[];
  outcome: TimelineOutcome | null;
  finished: boolean;
} {
  const steps: TimelineStep[] = [];
  const add = (label: string, done: boolean) => {
    const previousDone = steps.every((s) => s.state === "done");
    steps.push({ label, state: done ? "done" : previousDone ? "active" : "waiting" });
  };
  const run = trace?.run ?? null;
  const media = trace?.media ?? null;

  add("Llegó por WhatsApp (simulado, firmado como Meta)", Boolean(trace?.received));
  if (kind !== "injection") add("Archivo descargado y verificado", media?.status === "stored");
  if (kind === "audio") add("Nota de voz transcripta", media?.transcription === "done");
  if (kind === "planilla" || kind === "planilla_nueva")
    add("Planilla leída", media?.conversion === "done");
  add("Clasificado", Boolean(run && run.status !== "pending"));
  add("Extraído y validado con las reglas", Boolean(run && FINAL_RUN.has(run.status)));

  if (!run || !FINAL_RUN.has(run.status) || !trace?.message) {
    return { steps, outcome: null, finished: false };
  }
  const conversation = `/conversaciones/${trace.message.conversationId}`;
  if (run.status === "needs_review") {
    const last = steps.at(-1)!;
    last.state = "stopped";
    if (run.reason === "suspicious_instructions") {
      return {
        steps,
        finished: true,
        outcome: {
          text: "Frenado: el mensaje intenta darle órdenes al sistema. No se tocó el catálogo.",
          tone: "stopped",
          href: "/revisiones",
          linkText: "Ver en Revisiones",
        },
      };
    }
    if (run.reason === "column_mapping_required" || run.reason === "sheet_format_changed") {
      return {
        steps,
        finished: true,
        outcome: {
          text: "Planilla con un formato nuevo: elegí qué columna de precio usar.",
          tone: "review",
          href: "/revisiones",
          linkText: "Elegir la columna",
        },
      };
    }
    return {
      steps,
      finished: true,
      outcome: {
        text: "Quedó en Revisiones para que una persona decida.",
        tone: "review",
        href: "/revisiones",
        linkText: "Ver en Revisiones",
      },
    };
  }
  if (run.status === "ingested") {
    const parts = [
      run.priceChanges > 0
        ? plural(run.priceChanges, "precio actualizado", "precios actualizados")
        : null,
      run.createdProducts > 0
        ? plural(run.createdProducts, "producto nuevo", "productos nuevos")
        : null,
      run.pendingReviews > 0
        ? plural(run.pendingReviews, "línea para revisar", "líneas para revisar")
        : null,
    ].filter(Boolean);
    return {
      steps,
      finished: true,
      outcome: {
        text:
          parts.length > 0
            ? `Catálogo al día: ${parts.join(", ")}.`
            : "Procesado: no hubo cambios de precio.",
        tone: run.pendingReviews > 0 ? "review" : "success",
        href: run.pendingReviews > 0 ? "/revisiones" : "/catalogo",
        linkText: run.pendingReviews > 0 ? "Ver en Revisiones" : "Ver el catálogo",
      },
    };
  }
  steps.at(-1)!.state = "stopped";
  return {
    steps,
    finished: true,
    outcome: {
      text: "No se pudo procesar.",
      tone: "stopped",
      href: conversation,
      linkText: "Ver la conversación",
    },
  };
}
