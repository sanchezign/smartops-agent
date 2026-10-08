/**
 * The business language (`business.language`, ADR-031) is ONE setting for the whole business and it
 * does two things: it sets the language of the messages the system SENDS and the language in which
 * the messages, price lists and spreadsheets that ARRIVE are read. Changing it can make a business
 * stop recognizing what its suppliers send in the other language, so the panel asks first.
 * Pure — unit tested.
 */
export const BUSINESS_LANGUAGE_KEY = "business.language";

export function languageChange(
  changes: readonly (readonly [string, unknown])[],
  saved: unknown,
): { from: string | null; to: string } | null {
  const change = changes.find(([key]) => key === BUSINESS_LANGUAGE_KEY);
  if (!change || typeof change[1] !== "string") return null;
  const from = typeof saved === "string" ? saved : null;
  return from === change[1] ? null : { from, to: change[1] };
}
