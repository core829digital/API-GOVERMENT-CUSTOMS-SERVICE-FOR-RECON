import { NextResponse, type NextRequest } from "next/server";
import { AuthConfigError, loadAuthConfig } from "@/lib/auth/config";
import { SESSION_COOKIE } from "@/lib/auth/cookies";
import { openSession } from "@/lib/auth/session";
import { upstreamUrl } from "@/lib/bff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function error(code: string, status: number): NextResponse {
  return NextResponse.json({ error: code }, { status, headers: { "cache-control": "no-store" } });
}

/**
 * Same-origin proxy to the recon API. The bearer token lives only in the encrypted
 * HttpOnly session cookie and is attached here, server-side. Phase 1 consumes read
 * endpoints only, so only GET is proxied.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const base = process.env.RECON_API_BASE_URL;
  if (!base) {
    console.error("bff_not_configured", "RECON_API_BASE_URL");
    return error("api_not_configured", 503);
  }

  const { path } = await context.params;
  let target: URL | null;
  try {
    target = upstreamUrl(base, path, request.nextUrl.search);
  } catch {
    target = null;
  }
  if (!target) return error("bad_path", 400);

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

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: "GET",
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        accept: "application/json",
      },
      redirect: "manual",
      cache: "no-store",
      signal: request.signal,
    });
  } catch {
    return error("upstream_unreachable", 502);
  }

  const headers = new Headers({ "cache-control": "no-store" });
  for (const name of ["content-type", "retry-after"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new NextResponse(upstream.body, { status: upstream.status, headers });
}
