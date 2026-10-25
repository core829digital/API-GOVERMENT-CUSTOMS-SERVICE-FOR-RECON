import { expect, test } from "@playwright/test";

// The e2e environment points OIDC_ISSUER at an unresolvable host (https://idp.invalid), so anything that needs
// the IdP must fail closed, and fail onto the sign-in page rather than a raw error body.

function locationOf(headers: Record<string, string>): URL {
  const location = headers["location"];
  expect(location).toBeTruthy();
  return new URL(location!);
}

test("login ends on the sign-in page with idp_unreachable, sets no cookie and keeps the safe destination", async ({
  request,
}) => {
  const response = await request.get("/api/auth/login?returnTo=/findings", { maxRedirects: 0 });
  expect(response.status()).toBe(303);
  const location = locationOf(response.headers());
  expect(location.origin).toBe("http://localhost:3100");
  expect(location.pathname).toBe("/login");
  expect(location.searchParams.get("error")).toBe("idp_unreachable");
  expect(location.searchParams.get("returnTo")).toBe("/findings");
  expect(response.headers()["set-cookie"]).toBeUndefined();
  expect(response.headers()["cache-control"]).toBe("no-store");
});

test("login never carries an open-redirect destination through to the sign-in page", async ({ request }) => {
  const response = await request.get("/api/auth/login?returnTo=//evil.example/x", { maxRedirects: 0 });
  expect(response.status()).toBe(303);
  const location = locationOf(response.headers());
  expect(location.origin).toBe("http://localhost:3100");
  expect(location.searchParams.get("returnTo")).toBe("/overview");
});

test("a callback without the flow cookie ends on the sign-in page, sets no session and clears the flow cookie", async ({
  request,
}) => {
  const response = await request.get("/api/auth/callback?code=x&state=y", { maxRedirects: 0 });
  expect(response.status()).toBe(303);
  const location = locationOf(response.headers());
  expect(location.pathname).toBe("/login");
  expect(location.searchParams.get("error")).toBe("invalid_callback");

  const setCookie = response.headers()["set-cookie"] ?? "";
  expect(setCookie).toMatch(/__Host-recon_oidc_flow=;/);
  expect(setCookie).toMatch(/Max-Age=0/i);
  expect(setCookie).not.toContain("__Host-recon_session");
});

test("a callback with a forged flow cookie is rejected the same way", async ({ request }) => {
  const response = await request.get("/api/auth/callback?code=x&state=y", {
    maxRedirects: 0,
    headers: { cookie: "__Host-recon_oidc_flow=not-a-sealed-token" },
  });
  expect(response.status()).toBe(303);
  expect(locationOf(response.headers()).searchParams.get("error")).toBe("invalid_callback");
  expect(response.headers()["set-cookie"] ?? "").not.toContain("__Host-recon_session");
});

test("logout is POST-only, clears the session cookie and returns to the site", async ({ request }) => {
  expect((await request.get("/api/auth/logout", { maxRedirects: 0 })).status()).toBe(405);

  const response = await request.post("/api/auth/logout", { maxRedirects: 0 });
  expect(response.status()).toBe(303);
  expect(locationOf(response.headers()).pathname).toBe("/");
  const setCookie = response.headers()["set-cookie"] ?? "";
  expect(setCookie).toMatch(/__Host-recon_session=;/);
  expect(setCookie).toMatch(/Max-Age=0/i);
});
