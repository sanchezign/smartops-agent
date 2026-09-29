/**
 * Panel routes were Spanish until phase 13 (/revisiones, /conversaciones…). Old links (bookmarks,
 * WhatsApp digests already sent, shared screenshots) keep working through PERMANENT redirects to
 * the English routes, sub-paths included. /d/<token> never changed. Order matters: the more
 * specific /conversaciones/bajas comes first.
 */
export const LEGACY_ROUTES: readonly (readonly [from: string, to: string])[] = [
  ["/conversaciones/bajas", "/conversations/opted-out"],
  ["/revisiones", "/reviews"],
  ["/conversaciones", "/conversations"],
  ["/catalogo", "/catalog"],
  ["/alertas", "/alerts"],
  ["/reglas", "/rules"],
  ["/usuarios", "/users"],
  ["/probar", "/try"],
];

/** Next.js `redirects()` entries: the route itself and everything under it (308). */
export function legacyRedirects() {
  return LEGACY_ROUTES.flatMap(([from, to]) => [
    { source: from, destination: to, permanent: true },
    { source: `${from}/:path*`, destination: `${to}/:path*`, permanent: true },
  ]);
}
