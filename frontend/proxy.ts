import { NextResponse, type NextRequest } from "next/server";
import { AuthConfigError, loadAuthConfig } from "@/lib/auth/config";
import { SESSION_COOKIE } from "@/lib/auth/cookies";
import { decideGate, isProtectedPath } from "@/lib/auth/gate";
import { openSession } from "@/lib/auth/session";
import { buildCsp, newNonce } from "@/lib/csp";

/**
 * Runs on every page request (Node runtime) and does two things.
 *
 * 1. Console gate: requests to the console routes without a session that decrypts and is unexpired are
 *    redirected to the sign-in page. This is a navigation convenience, not the security boundary: the BFF
 *    re-checks the session on every API call. It never logs, forwards or echoes the cookie value.
 * 2. Content-Security-Policy with a per-request nonce: the policy goes on the response and, with the nonce in
 *    `x-nonce`, on the request so that Next.js can attach the nonce to its own scripts and styles and the root
 *    layout can hand it to the theme script (`lib/csp.ts`).
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;

  if (isProtectedPath(pathname)) {
    let sessionKey: Uint8Array | null = null;
    try {
      sessionKey = loadAuthConfig().sessionKey;
    } catch (error) {
      // Missing/invalid configuration fails closed. Any other error is a bug: let it surface as a 500, which
      // also serves nothing.
      if (!(error instanceof AuthConfigError)) throw error;
    }

    const authenticated =
      sessionKey !== null &&
      (await openSession(request.cookies.get(SESSION_COOKIE)?.value, sessionKey)) !== null;

    const decision = decideGate({ pathname, search, configured: sessionKey !== null, authenticated });
    if (decision.action === "redirect") {
      // APP_BASE_URL, not request.url: behind a load balancer the latter carries the internal host.
      const response = NextResponse.redirect(new URL(decision.path, publicOrigin(request)), 307);
      response.headers.set("cache-control", "no-store");
      return response;
    }
  }

  const nonce = newNonce();
  const csp = buildCsp(nonce, { development: process.env.NODE_ENV === "development" });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  return response;
}

function publicOrigin(request: NextRequest): string {
  try {
    return new URL(process.env.APP_BASE_URL ?? "").origin;
  } catch {
    return request.nextUrl.origin;
  }
}

export const config = {
  // Every page. `/api` (JSON; its headers come from next.config.ts), build assets and the favicon never need a nonce.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
