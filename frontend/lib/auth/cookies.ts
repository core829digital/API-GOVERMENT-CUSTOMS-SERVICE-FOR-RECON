/**
 * `__Host-` cookies must be Secure, have Path=/ and no Domain attribute, which pins them
 * to this exact origin. SameSite=Lax (not Strict) is required: the session cookie is set
 * on the redirect back from the IdP, and the flow cookie must be sent on that top-level
 * cross-site GET navigation; Strict cookies are withheld on such navigations.
 */
export const SESSION_COOKIE = "__Host-recon_session";
export const FLOW_COOKIE = "__Host-recon_oidc_flow";

export type CookieOptions = {
  httpOnly: true;
  secure: true;
  sameSite: "lax";
  path: "/";
  maxAge: number;
};

export function cookieOptions(maxAgeSeconds: number): CookieOptions {
  return {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: Math.max(0, Math.floor(maxAgeSeconds)),
  };
}

/** Options that make the browser delete the cookie (same attributes, Max-Age=0). */
export const expiredCookieOptions: CookieOptions = cookieOptions(0);
