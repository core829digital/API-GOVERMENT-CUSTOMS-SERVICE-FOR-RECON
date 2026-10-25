/** Where a login that names no (or no safe) destination lands: the console, not the marketing home. */
export const DEFAULT_RETURN_TO = "/overview";

/**
 * Only same-origin absolute paths are accepted as post-login destinations, so the login
 * endpoint cannot be used as an open redirect. Anything else falls back to `/overview`.
 */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/")) return DEFAULT_RETURN_TO;
  // "//host" and "/\host" are interpreted by browsers as protocol-relative URLs.
  if (value.startsWith("//") || value.startsWith("/\\")) return DEFAULT_RETURN_TO;
  // Control characters (CR/LF/TAB) are stripped by URL parsers and can smuggle a host.
  if (/[\u0000-\u001f\u007f]/.test(value)) return DEFAULT_RETURN_TO;
  return value;
}
