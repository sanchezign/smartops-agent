/**
 * WhatsApp customer service window (pure). A user message opens a 24h window during
 * which the business may send any message; outside it only approved templates.
 * We close it SAFETY_MARGIN_MS early: better to require a template slightly early than
 * to get a 131047 from Meta because of clock skew / queueing delay.
 */

export const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const WINDOW_SAFETY_MARGIN_MS = 2 * 60 * 1000;

export interface WindowState {
  open: boolean;
  /** When the window closes (with margin applied); null if never opened. */
  closesAt: Date | null;
}

export function customerServiceWindow(lastInboundAt: Date | null, now: Date): WindowState {
  if (!lastInboundAt) return { open: false, closesAt: null };
  const closesAt = new Date(
    lastInboundAt.getTime() + CUSTOMER_SERVICE_WINDOW_MS - WINDOW_SAFETY_MARGIN_MS,
  );
  return { open: now.getTime() < closesAt.getTime(), closesAt };
}
