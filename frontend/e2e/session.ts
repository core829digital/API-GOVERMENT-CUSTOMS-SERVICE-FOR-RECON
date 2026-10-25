import type { BrowserContext } from "@playwright/test";
import { SESSION_COOKIE } from "../lib/auth/cookies";
import { parseSecret } from "../lib/auth/seal";
import { sealSession } from "../lib/auth/session";

export const ORIGIN = "http://localhost:3100";

function key(): Uint8Array {
  const secret = process.env.E2E_SESSION_SECRET;
  if (!secret) throw new Error("E2E_SESSION_SECRET is set by playwright.config.ts");
  return parseSecret(secret);
}

/** A session cookie value the e2e server accepts. `ttlSeconds < 0` makes it already expired. */
export async function sessionCookieValue(ttlSeconds = 3600): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  // The token is a fixture: no API ever receives it (RECON_API_BASE_URL points at a closed port).
  return sealSession({ accessToken: "e2e-fixture-token", expiresAt }, key());
}

/**
 * Signs the browser context in the way the callback would: sealed, HttpOnly, Secure, host-only `__Host-` cookie.
 * `context.addCookies` cannot do this: it always sends a Domain attribute, which the `__Host-` prefix forbids
 * ("Invalid cookie fields"). CDP's `Network.setCookie` with only a url creates the host-only cookie.
 */
export async function signIn(context: BrowserContext): Promise<void> {
  const page = await context.newPage();
  try {
    const cdp = await context.newCDPSession(page);
    const { success } = await cdp.send("Network.setCookie", {
      name: SESSION_COOKIE,
      value: await sessionCookieValue(),
      url: `${ORIGIN}/`,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    });
    if (!success) throw new Error("the browser refused the session cookie");
  } finally {
    await page.close();
  }
}
