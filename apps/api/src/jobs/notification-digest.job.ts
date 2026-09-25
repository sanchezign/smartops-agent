import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Logger } from "../common/logger.js";
import type { NotificationService } from "../modules/notifications/notification.service.js";
import { QUEUES, type NotificationDigestJob } from "./queues.js";

/** Sends notification digests at the end of their window (phase 6, anti-spam). */
export async function registerNotificationDigestWorkers(
  boss: PgBoss,
  deps: { service: NotificationService; logger: Logger },
): Promise<void> {
  await boss.work(
    QUEUES.notificationDigest,
    { includeMetadata: true },
    async ([job]: JobWithMetadata<NotificationDigestJob>[]) => {
      if (!job) return;
      const log = deps.logger.child({ jobId: job.id, digestId: job.data.digestId });
      const result = await deps.service.processDigest(job.data.digestId, log);
      log.debug(result, "notification digest job handled");
    },
  );
  await boss.work(
    QUEUES.notificationDigestDlq,
    { includeMetadata: true },
    async ([job]: JobWithMetadata<NotificationDigestJob>[]) => {
      if (!job) return;
      deps.logger.error(
        { jobId: job.id, digestId: job.data.digestId },
        "notification digest could not be sent (it stays in the panel)",
      );
    },
  );
}
