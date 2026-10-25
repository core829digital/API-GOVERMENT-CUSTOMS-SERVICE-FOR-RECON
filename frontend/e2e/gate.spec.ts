import { expect, test } from "@playwright/test";
import { en } from "./catalogs";
import { ORIGIN, sessionCookieValue, signIn } from "./session";

test.use({ viewport: { width: 1280, height: 800 } });

const batchId = "0190c1f2-0000-7000-8000-0000000000aa";

test.describe("console routes without a session", () => {
  for (const path of ["/overview", "/findings", `/batches/${batchId}?tab=raw`]) {
    test(`${path} redirects to the sign-in page and remembers where to return`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login\?/);
      expect(new URL(page.url()).searchParams.get("returnTo")).toBe(path);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(en.login.title);
    });
  }

  test("answers with a 307 to the sign-in page and no cookie", async ({ request }) => {
    const response = await request.get("/findings", { maxRedirects: 0 });
    expect(response.status()).toBe(307);
    // Next serialises a same-origin redirect as a relative Location; resolve it like a browser would.
    const location = new URL(response.headers()["location"]!, ORIGIN);
    expect(location.origin).toBe("http://localhost:3100");
    expect(location.pathname + location.search).toBe("/login?returnTo=%2Ffindings");
    expect(response.headers()["set-cookie"]).toBeUndefined();
    expect(response.headers()["cache-control"]).toBe("no-store");
  });

  test("fails closed for a forged or expired session cookie", async ({ request }) => {
    const forged = await request.get("/overview", {
      maxRedirects: 0,
      headers: { cookie: "__Host-recon_session=not-a-sealed-token" },
    });
    expect(forged.status()).toBe(307);

    const expired = await request.get("/overview", {
      maxRedirects: 0,
      headers: { cookie: `__Host-recon_session=${await sessionCookieValue(-60)}` },
    });
    expect(expired.status()).toBe(307);
  });

  test("the sign-in page, the public site and the API are not gated", async ({ request }) => {
    for (const path of ["/", "/platform", "/checks", "/trust", "/login", "/api/auth/session"]) {
      const response = await request.get(path, { maxRedirects: 0 });
      expect(response.status(), path).toBe(200);
    }
  });
});

test.describe("console routes with a session", () => {
  test("a valid session reaches the page", async ({ page, context }) => {
    await signIn(context);
    await page.goto("/findings");
    await expect(page).toHaveURL(/\/findings$/);
    await expect(page.getByRole("heading", { level: 1, name: en.findings.title })).toBeVisible();
  });

  test("the sign-in page sends a signed-in visitor on to the safe destination", async ({ page, context }) => {
    await signIn(context);
    await page.goto("/login?returnTo=%2Ffindings");
    await expect(page).toHaveURL(/\/findings$/);

    await page.goto("/login");
    await expect(page).toHaveURL(/\/overview$/);

    await page.goto("/login?returnTo=%2F%2Fevil.example");
    await expect(page).toHaveURL(/\/overview$/);
  });

  test("an explicit error keeps a signed-in visitor on the sign-in page", async ({ page, context }) => {
    await signIn(context);
    await page.goto("/login?error=session_expired");
    await expect(page).toHaveURL(/\/login\?error=session_expired$/);
    await expect(page.getByRole("alert").filter({ hasText: en.login.notice.session_expired.title })).toBeVisible();
  });
});
