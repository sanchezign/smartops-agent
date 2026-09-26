import type { PrismaClient } from "../../common/db.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { ConsentEventKind, OptOutSource } from "../../generated/prisma/enums.js";

/**
 * Opt-in / opt-out persistence (phase 7, ADR-017). Append-only audit
 * (`contact_consent_events`) + the current flag on Contact (`optOutAt`/`optOutSource`).
 * Independent of `Contact.optInAt` (ADR-009's implicit inbound opt-in for templates):
 * an inbound message never clears an opt-out.
 */

export interface ConsentActor {
  userId?: string;
  /** e.g. "cli:ana", "system". */
  label?: string;
}

export interface ApplyComplianceEventInput {
  contactId: string;
  kind: ConsentEventKind;
  /** "keyword" | "manual" | "off_whatsapp" (free text, audit-log only). */
  method: string;
  keyword?: string;
  actor: ConsentActor;
  messageId?: string;
  note?: string;
  now: Date;
}

export type ApplyComplianceEventResult =
  /** opt_out on an already opted-out contact, or opt_in on one that was not opted out. */
  { changed: false } | { changed: true; optOutAt: Date | null };

export interface ContactConsentView {
  contactId: string;
  optOutAt: Date | null;
  optOutSource: OptOutSource | null;
  marketingOptOutAt: Date | null;
}

export interface OptOutRepository {
  /** Applies inside the caller's transaction (e.g. the message that triggered it). */
  applyInTx(
    tx: Prisma.TransactionClient,
    input: ApplyComplianceEventInput,
  ): Promise<ApplyComplianceEventResult>;
  apply(input: ApplyComplianceEventInput): Promise<ApplyComplianceEventResult>;
  find(
    ref: { waId: string } | { bsuid: string } | { contactId: string },
  ): Promise<ContactConsentView | null>;
  /** From the user_preferences webhook (informational — we send no marketing). */
  recordMarketingPreference(
    ref: { waId: string } | { bsuid: string },
    value: "stop" | "resume",
    at: Date,
  ): Promise<void>;
}

export function createOptOutRepository(prisma: PrismaClient): OptOutRepository {
  async function applyInTx(
    tx: Prisma.TransactionClient,
    input: ApplyComplianceEventInput,
  ): Promise<ApplyComplianceEventResult> {
    const contact = await tx.contact.findUniqueOrThrow({
      where: { id: input.contactId },
      select: { optOutAt: true },
    });
    if (input.kind === "opt_out") {
      // Already opted out: no duplicate event, no duplicate confirmation.
      if (contact.optOutAt) return { changed: false };
      await tx.contact.update({
        where: { id: input.contactId },
        data: { optOutAt: input.now, optOutSource: input.method as OptOutSource },
      });
    } else {
      // Nothing to re-enable: ALTA on a contact that was never opted out is a no-op.
      if (!contact.optOutAt) return { changed: false };
      await tx.contact.update({
        where: { id: input.contactId },
        data: { optOutAt: null, optOutSource: null },
      });
    }
    await tx.contactConsentEvent.create({
      data: {
        contactId: input.contactId,
        kind: input.kind,
        method: input.method,
        keyword: input.keyword ?? null,
        actorUserId: input.actor.userId ?? null,
        actorLabel: input.actor.label ?? null,
        messageId: input.messageId ?? null,
        note: input.note ?? null,
      },
    });
    return { changed: true, optOutAt: input.kind === "opt_out" ? input.now : null };
  }

  return {
    applyInTx,
    apply: (input) => prisma.$transaction((tx) => applyInTx(tx, input)),

    async find(ref) {
      const where =
        "contactId" in ref
          ? { id: ref.contactId }
          : "waId" in ref
            ? { waId: ref.waId }
            : { bsuid: ref.bsuid };
      const contact = await prisma.contact.findFirst({
        where,
        select: { id: true, optOutAt: true, optOutSource: true, marketingOptOutAt: true },
      });
      if (!contact) return null;
      return {
        contactId: contact.id,
        optOutAt: contact.optOutAt,
        optOutSource: contact.optOutSource,
        marketingOptOutAt: contact.marketingOptOutAt,
      };
    },

    async recordMarketingPreference(ref, value, at) {
      const where = "waId" in ref ? { waId: ref.waId } : { bsuid: ref.bsuid };
      await prisma.contact.updateMany({
        where,
        data: { marketingOptOutAt: value === "stop" ? at : null },
      });
    },
  };
}
