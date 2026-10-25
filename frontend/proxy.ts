import { NextResponse, type NextRequest } from "next/server";
import { AuthConfigError, loadAuthConfig } from "@/lib/auth/config";
import { SESSION_COOKIE } from "@/lib/auth/cookies";
import { decideGate } from "@/lib/auth/gate";
import { openSession } from "@/lib/auth/session";

/**
 * Console gate (Node runtime): requests to the console routes without a session that decrypts and is
 * unexpired are redirected to the sign-in page. This is a navigation convenience, not the security boundary:
 * the BFF re-checks the session on every API call. It never logs, forwards or echoes the cookie value.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;

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
  if (decision.action === "allow") return NextResponse.next();

  // APP_BASE_URL, not request.url: behind a load balancer the latter carries the internal host.
  const response = NextResponse.redirect(new URL(decision.path, publicOrigin(request)), 307);
  response.headers.set("cache-control", "no-store");
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
  // Only the console routes. `/api`, `/_next`, static files, `/login` and the public pages never reach the proxy.
  matcher: ["/overview/:path*", "/findings/:path*", "/batches/:path*"],
};
