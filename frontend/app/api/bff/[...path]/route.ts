import { NextResponse, type NextRequest } from "next/server";
import { AuthConfigError, loadAuthConfig } from "@/lib/auth/config";
import { SESSION_COOKIE } from "@/lib/auth/cookies";
import { openSession } from "@/lib/auth/session";
import { downstreamHeaders, upstreamHeaders, upstreamPath } from "@/lib/bff";
import { loadServiceKey, ServiceKeyError, signRequest, type ServiceKey } from "@/lib/service-signature";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function error(code: string, status: number): NextResponse {
  return NextResponse.json({ error: code }, { status, headers: { "cache-control": "no-store" } });
}

/**
 * Same-origin proxy to the recon API's INTERNAL listener (`RECON_API_INTERNAL_URL`). The bearer token lives only in
 * the encrypted HttpOnly session cookie and is attached here, server-side, together with a `RECON-SVC-V1` request
 * signature (`lib/service-signature.ts`) that the API requires on that listener. Only allowlisted v1 read routes,
 * query parameters and headers are forwarded (`lib/bff.ts`). Phase 1 consumes read endpoints only, so only GET is
 * proxied.
 *
 * Order: path allowlist (400), session (401), then upstream configuration (503): a visitor without a session
 * learns nothing about how the upstream is configured.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  const relative = upstreamPath(path, request.nextUrl.search);
  if (relative === null) return error("bad_path", 400);

  let sessionKey: Uint8Array;
  try {
    sessionKey = loadAuthConfig().sessionKey;
  } catch (cause) {
    if (cause instanceof AuthConfigError) {
      console.error("auth_not_configured", cause.variables.join(","));
      return error("auth_not_configured", 503);
    }
    throw cause;
  }

  const session = await openSession(request.cookies.get(SESSION_COOKIE)?.value, sessionKey);
  if (!session) return error("unauthenticated", 401);

  const base = process.env.RECON_API_INTERNAL_URL;
  let target: URL | null = null;
  try {
    if (base) target = new URL(`${base.replace(/\/+$/, "")}${relative}`);
  } catch {
    target = null;
  }
  let serviceKey: ServiceKey | null = null;
  try {
    serviceKey = loadServiceKey();
  } catch (cause) {
    if (!(cause instanceof ServiceKeyError)) throw cause;
    console.error("bff_not_configured", cause.variables.join(","));
  }
  if (!target || !serviceKey) {
    if (!target) console.error("bff_not_configured", "RECON_API_INTERNAL_URL");
    return error("api_not_configured", 503);
  }

  const headers = upstreamHeaders(request.headers, session.accessToken);
  for (const [name, value] of Object.entries(signRequest(serviceKey, { method: "GET", url: target }))) {
    headers.set(name, value);
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: "GET",
      headers,
      redirect: "manual",
      cache: "no-store",
      signal: request.signal,
    });
  } catch {
    return error("upstream_unreachable", 502);
  }
  // The API never redirects; treat it as a broken upstream instead of passing a Location to the browser.
  if (upstream.status >= 300 && upstream.status < 400) return error("bad_upstream", 502);

  return new NextResponse(upstream.body, { status: upstream.status, headers: downstreamHeaders(upstream.headers) });
}
