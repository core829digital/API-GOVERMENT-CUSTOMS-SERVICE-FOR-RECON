import { loginPath } from "./login-url";
import { safeReturnTo } from "./return-to";

/** Console routes that require a session. Mirrors `config.matcher` in `proxy.ts`. */
const PROTECTED_PREFIXES = ["/overview", "/findings", "/batches"] as const;

export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export type GateDecision = { action: "allow" } | { action: "redirect"; path: string };

/**
 * Pure routing decision of the console gate. Fails closed: anything that is not a proven session on a
 * protected path is sent to the sign-in page.
 */
export function decideGate(input: {
  pathname: string;
  search: string;
  /** `false` when the IdP/session configuration is missing or invalid. */
  configured: boolean;
  authenticated: boolean;
}): GateDecision {
  if (!isProtectedPath(input.pathname)) return { action: "allow" };
  if (!input.configured) return { action: "redirect", path: loginPath({ error: "not_configured" }) };
  if (input.authenticated) return { action: "allow" };
  return { action: "redirect", path: loginPath({ returnTo: returnPath(input.pathname, input.search) }) };
}

/** Path + query to come back to, without Next's internal RSC cache-busting parameter. */
function returnPath(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  params.delete("_rsc");
  const query = params.toString();
  return safeReturnTo(query ? `${pathname}?${query}` : pathname);
}
