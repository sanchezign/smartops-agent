import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Logger } from "../common/logger.js";
import type { ConversationModeService } from "../modules/conversations/conversation-mode.service.js";
import { QUEUES, type ConversationBotResumeJob } from "./queues.js";

const SWEEPER_CRON = "*/5 * * * *";

/**
 * Bot reactivation after a human takeover (phase 7, ADR-016):
 * - conversation-bot-resume: scheduled at humanUntil in the takeover transaction; re-checks
 *   under the conversation lock (extended / resumed by hand → no-op).
 * - conversation-mode-sweeper (every 5 min): reactivates expired conversations whose job
 *   was lost.
 */
export async function registerConversationModeWorkers(
  boss: PgBoss,
  deps: { service: ConversationModeService; logger: Logger },
): Promise<void> {
  await boss.work(
    QUEUES.conversationBotResume,
    { includeMetadata: true },
    async ([job]: JobWithMetadata<ConversationBotResumeJob>[]) => {
      if (!job) return;
      const log = deps.logger.child({
        jobId: job.id,
        conversationId: job.data.conversationId,
        attempt: job.retryCount + 1,
      });
      await deps.service.onTimeout(job.data.conversationId, log);
    },
  );

  await boss.schedule(QUEUES.conversationModeSweeper, SWEEPER_CRON);
  await boss.work(QUEUES.conversationModeSweeper, async () => {
    await deps.service.sweepExpired(deps.logger.child({ job: QUEUES.conversationModeSweeper }));
  });
}
