import { NextResponse, type NextRequest } from "next/server";
import { AuthConfigError, loadAuthConfig, type AuthConfig } from "./config";
import { cookieOptions, expiredCookieOptions, FLOW_COOKIE, SESSION_COOKIE } from "./cookies";
import { loginPath, type LoginErrorCode } from "./login-url";
import { client, getOidcConfiguration } from "./oidc";
import { codeChallengeS256, generateCodeVerifier, generateNonce, generateState } from "./pkce";
import { safeReturnTo } from "./return-to";
import { seal, unseal, type FlowPayload } from "./seal";
import { openSession, sealSession } from "./session";

/** The flow cookie only needs to outlive the round trip to the IdP. */
const FLOW_TTL_SECONDS = 600;

function noStore(response: NextResponse): NextResponse {
  response.headers.set("cache-control", "no-store");
  return response;
}

function json(body: unknown, status: number): NextResponse {
  return noStore(NextResponse.json(body, { status }));
}

/** APP_BASE_URL, not request.url: behind a load balancer the latter carries the internal host. */
function publicOrigin(request: NextRequest): string {
  try {
    return new URL(process.env.APP_BASE_URL ?? "").origin;
  } catch {
    return request.nextUrl.origin;
  }
}

/**
 * These endpoints are reached by browser navigation, so a failure must end on the sign-in page, not on a raw
 * JSON body. 303 turns whatever the method was into a GET. No session cookie is ever set here.
 */
function failToLogin(request: NextRequest, error: LoginErrorCode, returnTo?: string): NextResponse {
  const path = loginPath({ error, returnTo });
  return noStore(NextResponse.redirect(new URL(path, publicOrigin(request)), 303));
}

function configOrResponse(request: NextRequest): AuthConfig | NextResponse {
  try {
    return loadAuthConfig();
  } catch (error) {
    if (error instanceof AuthConfigError) {
      console.error("auth_not_configured", error.variables.join(","));
      return failToLogin(request, "not_configured");
    }
    throw error;
  }
}

/** Never log tokens, claims or exception messages (R-PRIV-1): only the error class/code. */
function logFailure(event: string, error: unknown): void {
  let code = "unknown";
  if (typeof error === "object" && error !== null && "code" in error) code = String(error.code);
  else if (error instanceof Error) code = error.name;
  console.error(event, code);
}

/**
 * Whether a failed token exchange never got a usable answer from the IdP (network failure, timeout, a gateway
 * answer that is not the token endpoint's). Everything else, including an OAuth error response, is a failed
 * callback.
 */
function isIdpUnreachable(error: unknown): boolean {
  if (error instanceof client.ClientError) {
    return (
      error.code === undefined ||
      error.code === "OAUTH_TIMEOUT" ||
      error.code === "OAUTH_ABORT" ||
      error.code === "OAUTH_RESPONSE_IS_NOT_CONFORM" ||
      error.code === "OAUTH_RESPONSE_IS_NOT_JSON"
    );
  }
  // `fetch` rejects with a plain TypeError on connection failures; argument-validation TypeErrors carry a code.
  return error instanceof TypeError && !("code" in error);
}

export async function handleLogin(request: NextRequest): Promise<NextResponse> {
  const config = configOrResponse(request);
  if (config instanceof NextResponse) return config;

  const codeVerifier = generateCodeVerifier();
  const state = generateState();
  const nonce = generateNonce();
  const returnTo = safeReturnTo(request.nextUrl.searchParams.get("returnTo"));

  let authorizationUrl: URL;
  try {
    const oidc = await getOidcConfiguration(config);
    authorizationUrl = client.buildAuthorizationUrl(oidc, {
      redirect_uri: config.redirectUri.href,
      scope: config.scope,
      response_type: "code",
      code_challenge: codeChallengeS256(codeVerifier),
      code_challenge_method: "S256",
      state,
      nonce,
    });
  } catch (error) {
    logFailure("oidc_login_failed", error);
    return failToLogin(request, "idp_unreachable", returnTo);
  }

  const flow: FlowPayload = { state, nonce, codeVerifier, returnTo };
  const expiresAt = Math.floor(Date.now() / 1000) + FLOW_TTL_SECONDS;
  const response = noStore(NextResponse.redirect(authorizationUrl, 302));
  response.cookies.set(
    FLOW_COOKIE,
    await seal("flow", flow, config.sessionKey, expiresAt),
    cookieOptions(FLOW_TTL_SECONDS),
  );
  return response;
}

export async function handleCallback(request: NextRequest): Promise<NextResponse> {
  const config = configOrResponse(request);
  if (config instanceof NextResponse) return config;

  /** Ends on the sign-in page, never sets a session, always drops the (single-use) flow cookie. */
  const failed = (error: LoginErrorCode, returnTo?: string) => {
    const response = failToLogin(request, error, returnTo);
    response.cookies.set(FLOW_COOKIE, "", expiredCookieOptions);
    return response;
  };

  const payload = request.cookies.get(FLOW_COOKIE)?.value;
  const opened = payload ? await unseal("flow", payload, config.sessionKey) : null;
  if (
    !opened ||
    typeof opened.state !== "string" ||
    typeof opened.nonce !== "string" ||
    typeof opened.codeVerifier !== "string" ||
    typeof opened.returnTo !== "string"
  ) {
    return failed("invalid_callback");
  }
  const returnTo = safeReturnTo(opened.returnTo);

  let oidc: client.Configuration;
  try {
    oidc = await getOidcConfiguration(config);
  } catch (error) {
    logFailure("oidc_callback_failed", error);
    return failed("idp_unreachable", returnTo);
  }

  let accessToken: string;
  let expiresAt: number;
  try {
    // The public URL is rebuilt from APP_BASE_URL: behind a load balancer `request.url`
    // carries the internal host, which would fail redirect_uri matching.
    const currentUrl = new URL(config.redirectUri);
    currentUrl.search = request.nextUrl.search;
    const tokens = await client.authorizationCodeGrant(oidc, currentUrl, {
      pkceCodeVerifier: opened.codeVerifier,
      expectedState: opened.state,
      expectedNonce: opened.nonce,
      idTokenExpected: true,
    });
    accessToken = tokens.access_token;
    const now = Math.floor(Date.now() / 1000);
    // `expires_in` is only RECOMMENDED by RFC 6749; the ID token `exp` is mandatory.
    const idTokenExp = tokens.claims()?.exp;
    expiresAt = tokens.expires_in !== undefined ? now + tokens.expires_in : (idTokenExp ?? 0);
    if (expiresAt <= now) return failed("invalid_callback", returnTo);
  } catch (error) {
    logFailure("oidc_callback_failed", error);
    return failed(isIdpUnreachable(error) ? "idp_unreachable" : "invalid_callback", returnTo);
  }

  const response = noStore(NextResponse.redirect(new URL(returnTo, config.redirectUri), 302));
  response.cookies.set(
    SESSION_COOKIE,
    await sealSession({ accessToken, expiresAt }, config.sessionKey),
    cookieOptions(expiresAt - Math.floor(Date.now() / 1000)),
  );
  response.cookies.set(FLOW_COOKIE, "", expiredCookieOptions);
  return response;
}

/**
 * Clears the local session only. RP-initiated logout at the IdP needs an `id_token_hint`,
 * which is deliberately not stored (cookie size); the IdP session is left untouched.
 */
export function handleLogout(request: NextRequest): NextResponse {
  const home = new URL("/", publicOrigin(request));
  const response = noStore(NextResponse.redirect(home, 303));
  response.cookies.set(SESSION_COOKIE, "", expiredCookieOptions);
  return response;
}

export async function handleSession(request: NextRequest): Promise<NextResponse> {
  let config: AuthConfig;
  try {
    config = loadAuthConfig();
  } catch (error) {
    if (error instanceof AuthConfigError) {
      console.error("auth_not_configured", error.variables.join(","));
      // Without IdP configuration nobody can have a session; report that rather than failing.
      return json({ authenticated: false }, 200);
    }
    throw error;
  }
  const session = await openSession(
    request.cookies.get(SESSION_COOKIE)?.value,
    config.sessionKey,
  );
  return json(session ? { authenticated: true } : { authenticated: false }, 200);
}
