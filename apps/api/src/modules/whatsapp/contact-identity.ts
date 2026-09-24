/**
 * Contact identity resolution (pure). A WhatsApp user is identified by its phone
 * number (waId) and/or its business-scoped user id (bsuid). Lookup order: bsuid first
 * (stable while the user keeps the number), then waId. Missing identifiers are filled
 * in; two different existing contacts are NEVER merged automatically (reported as a
 * conflict so a human can review it).
 */

export interface ExistingContact {
  id: string;
  waId: string | null;
  bsuid: string | null;
  name: string | null;
  username: string | null;
}

export interface IncomingIdentity {
  waId: string | null;
  bsuid: string | null;
  name: string | null;
  username: string | null;
}

export interface ContactChanges {
  waId?: string;
  bsuid?: string;
  name?: string;
  username?: string;
}

export type ContactPlan =
  | { action: "create"; data: IncomingIdentity }
  | { action: "update"; id: string; data: ContactChanges }
  | { action: "none"; id: string };

export interface ContactPlanResult {
  plan: ContactPlan;
  /** Set when bsuid and waId point to two different contacts (kept apart, logged). */
  conflict?: { bsuidContactId: string; waIdContactId: string };
}

export class MissingIdentityError extends Error {
  constructor() {
    super("WhatsApp message has neither wa_id nor user_id (BSUID)");
    this.name = "MissingIdentityError";
  }
}

export function planContactUpsert(
  byBsuid: ExistingContact | null,
  byWaId: ExistingContact | null,
  incoming: IncomingIdentity,
): ContactPlanResult {
  if (!incoming.waId && !incoming.bsuid) throw new MissingIdentityError();

  const conflict =
    byBsuid && byWaId && byBsuid.id !== byWaId.id
      ? { bsuidContactId: byBsuid.id, waIdContactId: byWaId.id }
      : undefined;
  const existing = byBsuid ?? byWaId;

  if (!existing) return { plan: { action: "create", data: incoming } };

  const data: ContactChanges = {};
  // Fill identifiers only when nobody else owns them (unique constraints).
  if (incoming.bsuid && !existing.bsuid && !byBsuid) data.bsuid = incoming.bsuid;
  if (incoming.waId && !existing.waId && !byWaId) data.waId = incoming.waId;
  if (incoming.name && incoming.name !== existing.name) data.name = incoming.name;
  if (incoming.username && incoming.username !== existing.username) {
    data.username = incoming.username;
  }

  const plan: ContactPlan =
    Object.keys(data).length > 0
      ? { action: "update", id: existing.id, data }
      : { action: "none", id: existing.id };
  return conflict ? { plan, conflict } : { plan };
}
