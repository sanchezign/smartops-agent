/**
 * The public demo operator (phase 12): every visitor of the public demo logs in with the same
 * credentials, shown on the login screen. Account-wide actions ("close all my sessions") would
 * hit every other visitor, so the panel hides them for this account — the API refuses them too.
 */
export function isPublicDemoAccount(
  demo: { operator: { email: string } } | null | undefined,
  email: string | null | undefined,
): boolean {
  if (!demo || !email) return false;
  return demo.operator.email.trim().toLowerCase() === email.trim().toLowerCase();
}
