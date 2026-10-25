/**
 * Error codes carried to the sign-in page as `/login?error=<code>`. The page maps each one to a calm message;
 * an unknown value is never echoed back (it renders the generic message).
 */
export const LOGIN_ERROR_CODES = [
  "idp_unreachable",
  "invalid_callback",
  "not_configured",
  "session_expired",
  "signed_out",
] as const;

export type LoginErrorCode = (typeof LOGIN_ERROR_CODES)[number];

/** What the sign-in page shows for a raw `?error=` value: a known code, `unknown`, or nothing. */
export type LoginNoticeKey = LoginErrorCode | "unknown";

export function parseLoginError(value: string | null | undefined): LoginNoticeKey | null {
  if (value === null || value === undefined || value === "") return null;
  return (LOGIN_ERROR_CODES as readonly string[]).includes(value) ? (value as LoginErrorCode) : "unknown";
}

/**
 * Path (relative, same origin) of the sign-in page. `returnTo` must already have passed `safeReturnTo`.
 * The caller resolves it against the public origin.
 */
export function loginPath(options: { error?: LoginErrorCode; returnTo?: string } = {}): string {
  const params = new URLSearchParams();
  if (options.error) params.set("error", options.error);
  if (options.returnTo) params.set("returnTo", options.returnTo);
  const query = params.toString();
  return query ? `/login?${query}` : "/login";
}

/** The browser-navigated endpoint that starts the OIDC flow. */
export function loginStartPath(returnTo: string): string {
  return `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}
