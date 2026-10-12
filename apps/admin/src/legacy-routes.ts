/**
 * Old panel routes keep working (bookmarks, WhatsApp digests already sent, shared screenshots)
 * through PERMANENT redirects:
 * - phase 13: the Spanish routes (/revisiones, /conversaciones…) → the English ones;
 * - phase 15 (ADR-032): the review LIST moved to /todo (a review's own page stays /reviews/<id>)
 *   and the alerts became Activity (/activity).
 * Each entry: the route → `to`, and everything under it → `sub` (default `to`; null = sub-paths
 * are a live route, not redirected). /d/<token> never changed. Order matters: the more specific
 * /conversaciones/bajas comes first.
 */
export const LEGACY_ROUTES: readonly {
  from: string;
  to: string;
  sub?: string | null;
}[] = [
  { from: "/conversaciones/bajas", to: "/conversations/opted-out" },
  { from: "/revisiones", to: "/todo", sub: "/reviews" },
  { from: "/conversaciones", to: "/conversations" },
  { from: "/catalogo", to: "/catalog" },
  { from: "/alertas", to: "/activity" },
  { from: "/reglas", to: "/rules" },
  { from: "/usuarios", to: "/users" },
  { from: "/probar", to: "/try" },
  { from: "/reviews", to: "/todo", sub: null },
  { from: "/alerts", to: "/activity" },
];

/** Next.js `redirects()` entries: the route itself and (unless `sub` is null) everything under it (308). */
export function legacyRedirects() {
  return LEGACY_ROUTES.flatMap(({ from, to, sub }) => [
    { source: from, destination: to, permanent: true },
    ...(sub === null
      ? []
      : [{ source: `${from}/:path*`, destination: `${sub ?? to}/:path*`, permanent: true }]),
  ]);
}
