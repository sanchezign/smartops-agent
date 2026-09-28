/**
 * The PUBLIC demo operator (phase 12, user addendum A): in DEMO_MODE every visitor logs in as
 * the same operator, whose credentials are shown on the login screen. Anything scoped to "the
 * user" is therefore shared by strangers, so for this one account:
 *
 * - login failures never lock it (5 wrong passwords would lock it for everybody — a trivial
 *   DoS); logins are limited per IP by the login limiter instead;
 * - the cap of live event streams applies per IP, not per user (the 6th visitor would otherwise
 *   get no real time);
 * - "close every session", password / role / active changes and admin session revocation are
 *   refused: they would log out or lock out every other visitor, or outlive the demo reset.
 *
 * Outside DEMO_MODE nothing is public: `isPublic` is always false.
 */
export interface PublicAccount {
  /** Normalized email of the public operator, or null outside DEMO_MODE. */
  readonly email: string | null;
  isPublic(email: string | null | undefined): boolean;
}

export function createPublicAccount(options: {
  demoMode: boolean;
  operatorEmail: string;
}): PublicAccount {
  const email = options.demoMode ? normalize(options.operatorEmail) : null;
  return {
    email,
    isPublic: (candidate) => email !== null && !!candidate && normalize(candidate) === email,
  };
}

/** No public account (tests, CLIs, anything outside DEMO_MODE). */
export const NO_PUBLIC_ACCOUNT: PublicAccount = createPublicAccount({
  demoMode: false,
  operatorEmail: "",
});

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

/** Error message when a shared-account action is refused (403 FORBIDDEN). */
export const PUBLIC_ACCOUNT_REFUSED =
  "The public demo account is shared by every visitor: this action is disabled";
