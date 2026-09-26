import type { PrismaClient } from "../../common/db.js";
import type { EmitMessageReadyInTx } from "../integration/message-ready.js";

/**
 * After a person approves a review that sends a run BACK to extraction (column_mapping →
 * "classified", extraction_failed → "pending"/"classified"), nothing used to re-trigger the
 * pipeline (phase 6 known issue). The panel now re-emits `message.ready` with a dedupe key
 * per approval, so n8n picks the run up with the existing workflows (classify returns the
 * existing run without calling the LLM, the receiver routes it to the processor).
 */
const NEEDS_PROCESSING = new Set(["pending", "classified"]);

export function createRunRetrigger(deps: {
  prisma: PrismaClient;
  emitMessageReadyInTx: EmitMessageReadyInTx;
}) {
  return async (runId: string, reason: string): Promise<{ retriggered: boolean }> => {
    const run = await deps.prisma.ingestionRun.findUnique({
      where: { id: runId },
      select: { status: true, messageId: true },
    });
    if (!run || !NEEDS_PROCESSING.has(run.status)) return { retriggered: false };
    const { created } = await deps.prisma.$transaction((tx) =>
      deps.emitMessageReadyInTx(tx, { messageId: run.messageId }, { retrigger: reason }),
    );
    return { retriggered: created };
  };
}
