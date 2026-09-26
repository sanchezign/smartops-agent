import { createHash } from "node:crypto";
import { AppError, errors } from "../../common/errors/app-error.js";
import type { Logger } from "../../common/logger.js";
import type { OutboundService } from "../messaging/outbound.service.js";
import type { SettingsService } from "../settings/settings.service.js";
import {
  isActionableRun,
  nextAllowedSend,
  renderDigest,
  runTitle,
  type ItemData,
} from "./digest-rules.js";
import { PANEL, type NotificationRepository } from "./notification.repository.js";
import type { NotifyInput, N8nErrorInput } from "./notification.schemas.js";

/**
 * Notifications (phase 6). n8n (notifier) says WHAT happened; the backend decides whether it
 * is actionable, who is told and how (anti-spam rules, window, opt-in, templates):
 * - every actionable item goes to the panel; WhatsApp recipients get it through a digest
 *   (default 10 min window, hourly cap; excess waits for the next digest);
 * - critical integration errors skip the window while under their own hourly cap;
 * - a run without news notifies nobody (it is in the panel anyway).
 * Idempotent: the same (event, recipient) is recorded once, so n8n retries are harmless.
 */

export interface NotifyResult {
  notified: boolean;
  reason?: "nothing_actionable" | "duplicate";
  items: number;
}

export interface NotificationService {
  notify(input: NotifyInput, log: Logger): Promise<NotifyResult>;
  recordN8nError(input: N8nErrorInput, log: Logger): Promise<NotifyResult & { alertId: string }>;
  processDigest(digestId: string, log: Logger): Promise<{ outcome: string }>;
}

const MINUTE = 60_000;

export function createNotificationService(deps: {
  repository: NotificationRepository;
  settings: SettingsService;
  /** Only in the worker (digests are sent there). */
  outbound?: OutboundService;
  now?: () => Date;
}): NotificationService {
  const now = deps.now ?? (() => new Date());

  async function config(log: Logger) {
    const all = await deps.settings.getAll(log);
    return {
      recipients: all["notifications.whatsappRecipients"] as string[],
      windowMs: (all["notifications.digestWindowMinutes"] as number) * MINUTE,
      maxPerHour: all["notifications.maxPerHour"] as number,
      criticalMaxPerHour: all["notifications.criticalMaxPerHour"] as number,
      template: all["notifications.template"] as {
        name: string;
        languageCode: string;
        bodyParam: boolean;
      } | null,
      thresholdPct: all["catalog.priceAlertPct"] as number,
    };
  }

  async function record(
    item: {
      category: ItemData["category"];
      severity: "info" | "warning" | "critical";
      dedupeKey: string;
      title: string;
      data: ItemData;
    },
    log: Logger,
  ): Promise<NotifyResult> {
    const cfg = await config(log);
    const { created, duplicates } = await deps.repository.record({
      ...item,
      recipients: [PANEL, ...cfg.recipients],
      windowMs: cfg.windowMs,
      criticalCap: item.severity === "critical" ? cfg.criticalMaxPerHour : null,
      now: now(),
    });
    if (created === 0 && duplicates > 0) return { notified: false, reason: "duplicate", items: 0 };
    log.info({ category: item.category, recipients: created }, "notification recorded");
    return { notified: true, items: created };
  }

  return {
    async notify(input, log) {
      const cfg = await config(log);
      switch (input.kind) {
        case "run": {
          const facts = await deps.repository.runFacts(input.runId, cfg.thresholdPct);
          if (!facts) throw errors.notFound("Ingestion run not found");
          if (!isActionableRun(facts))
            return { notified: false, reason: "nothing_actionable", items: 0 };
          return record(
            {
              category: "run_summary",
              severity:
                facts.pendingReviews > 0 || facts.increasesOverThreshold > 0 ? "warning" : "info",
              dedupeKey: `run:${input.runId}`,
              title: runTitle(facts),
              data: { category: "run_summary", ...facts },
            },
            log,
          );
        }
        case "customer_query": {
          const message = await deps.repository.customerMessage(input.messageId);
          if (!message) throw errors.notFound("Message not found");
          const preview = (message.text ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
          return record(
            {
              category: "customer_query",
              severity: "info",
              dedupeKey: `customer_query:${input.messageId}`,
              title: `Consulta de ${message.contactName ?? "un cliente"}: ${preview}`,
              data: {
                category: "customer_query",
                messageId: input.messageId,
                contactName: message.contactName,
                preview,
              },
            },
            log,
          );
        }
        case "manual_attention": {
          const title = await deps.repository.alertTitle(input.alertId);
          if (!title) throw errors.notFound("Alert not found");
          return record(
            {
              category: "manual_attention",
              severity: "info",
              dedupeKey: `alert:${input.alertId}`,
              title,
              data: { category: "manual_attention", title },
            },
            log,
          );
        }
      }
    },

    async recordN8nError(input, log) {
      const message = input.message.replace(/\s+/g, " ").trim().slice(0, 300);
      const source = `n8n · ${input.workflow}${input.node ? ` · ${input.node}` : ""}`;
      const alertId = await deps.repository.createIntegrationAlert({
        title: `Error en ${source}: ${message}`,
        payload: {
          reason: "n8n_workflow_error",
          workflow: input.workflow,
          node: input.node ?? null,
          executionId: input.executionId ?? null,
          message,
        },
      });
      const dedupeKey = `n8n_error:${input.executionId ?? createHash("sha256").update(`${input.workflow}|${message}`).digest("hex").slice(0, 32)}`;
      const result = await record(
        {
          category: "integration_error",
          severity: "critical",
          dedupeKey,
          title: `Error en ${source}: ${message}`,
          data: { category: "integration_error", source, message },
        },
        log,
      );
      return { ...result, alertId };
    },

    async processDigest(digestId, log) {
      if (!deps.outbound) throw new Error("processDigest needs the outbound service (worker)");
      const digest = await deps.repository.getDigest(digestId);
      if (!digest || digest.status !== "open") return { outcome: "skipped" };
      const at = now();
      if (digest.windowEndsAt > at) {
        await deps.repository.postpone(digest.id, digest.windowEndsAt); // job ran early
        return { outcome: "waiting" };
      }
      const cfg = await config(log);
      if (!digest.critical) {
        const until = nextAllowedSend(
          await deps.repository.recentSends(digest.recipient, false, at),
          cfg.maxPerHour,
          at,
        );
        if (until) {
          // Hourly cap reached: keep collecting until a slot frees up (one message later).
          await deps.repository.postpone(digest.id, until);
          log.info({ digestId, until }, "notification digest postponed (hourly cap)");
          return { outcome: "postponed" };
        }
      }

      const text = renderDigest(digest.items.map((i) => i.data));
      const idempotencyKey = `digest:${digest.id}`;
      const recipient = { waId: digest.recipient };
      const settle = async (
        status: "sent" | "panel_only",
        channel: string,
        messageId: string | null,
        error?: string,
      ) => {
        await deps.repository.close(digest.id, {
          status,
          text,
          channel,
          outboundMessageId: messageId,
          sentAt: now(),
          ...(error ? { error } : {}),
        });
        log.info({ digestId, channel, items: digest.items.length }, "notification digest settled");
        return { outcome: status };
      };

      try {
        const sent = await deps.outbound.send(
          {
            recipient,
            content: { kind: "text", body: text },
            author: "bot",
            purpose: "team_notification",
            idempotencyKey,
          },
          log,
        );
        return settle("sent", "text", sent.messageId);
      } catch (err) {
        if (!(err instanceof AppError) || err.code !== "WINDOW_CLOSED") throw err;
      }
      // Outside the 24 h window: only an approved template (utility), with opt-in.
      if (!cfg.template)
        return settle("panel_only", "panel_only", null, "window closed and no template configured");
      try {
        const sent = await deps.outbound.send(
          {
            recipient,
            content: {
              kind: "template",
              name: cfg.template.name,
              languageCode: cfg.template.languageCode,
              ...(cfg.template.bodyParam
                ? { components: [{ type: "body", parameters: [{ type: "text", text }] }] }
                : {}),
            },
            author: "bot",
            purpose: "team_notification",
            idempotencyKey: `${idempotencyKey}:template`,
          },
          log,
        );
        return settle("sent", "template", sent.messageId);
      } catch (err) {
        if (err instanceof AppError && err.code === "OPT_IN_REQUIRED") {
          return settle("panel_only", "panel_only", null, "recipient without opt-in");
        }
        throw err;
      }
    },
  };
}
