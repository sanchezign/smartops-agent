/**
 * Filters kept in the URL (phase 16 M6a, Web Interface Guidelines "URL as state"): refresh, Back /
 * Forward and a shared link keep them. ONLY closed choices and opaque ids go there — never the free
 * text of a search box, which can hold a customer's phone or name (owner's rule: it would stay in the
 * browser history and in the proxy logs). The default value leaves the URL clean. Pure — unit tested.
 */

/** The raw param if it is one of the allowed values, else the fallback. */
export function pickOne<T extends string | number>(
  raw: string | null,
  allowed: readonly T[],
  fallback: T,
): T {
  if (raw === null) return fallback;
  return allowed.find((a) => String(a) === raw) ?? fallback;
}

/** An opaque id (a supplier's uuid), or null for anything else. */
export function idParam(raw: string | null): string | null {
  return raw !== null && /^[A-Za-z0-9_-]{1,64}$/.test(raw) ? raw : null;
}

/** The query string (with "?", or "") after setting `key`; null removes it. Other params stay. */
export function withParam(current: string, key: string, value: string | null): string {
  const params = new URLSearchParams(current);
  if (value === null) params.delete(key);
  else params.set(key, value);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}
