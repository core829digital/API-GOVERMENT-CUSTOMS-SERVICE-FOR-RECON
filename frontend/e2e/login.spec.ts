import { expect, test } from "@playwright/test";
import { en, ro } from "./catalogs";

test.use({ viewport: { width: 1280, height: 800 } });

test("the sign-in page offers one plain link into the OIDC flow", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(en.login.title);
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page).toHaveTitle(new RegExp(`^${en.login.metaTitle}`));

  const signIn = page.getByRole("link", { name: en.common.signIn });
  await expect(signIn).toHaveAttribute("href", "/api/auth/login?returnTo=%2Foverview");
  await expect(page.getByRole("link", { name: en.login.backToSite })).toHaveAttribute("href", "/");
  await expect(page.getByRole("button", { name: en.shell.language.label })).toBeVisible();
  await expect(page.getByRole("button", { name: en.shell.theme.label })).toBeVisible();
  // No error was asked for, so nothing is announced.
  await expect(page.getByRole("alert").filter({ hasText: en.login.notice.unknown.title })).toHaveCount(0);
});

test("returnTo is carried to the login endpoint only when it is a same-origin path", async ({ page }) => {
  const signIn = page.getByRole("link", { name: en.common.signIn });

  await page.goto("/login?returnTo=%2Fbatches%2Fabc%3Fx%3D1");
  await expect(signIn).toHaveAttribute("href", "/api/auth/login?returnTo=%2Fbatches%2Fabc%3Fx%3D1");

  await page.goto("/login?returnTo=https%3A%2F%2Fevil.example%2F");
  await expect(signIn).toHaveAttribute("href", "/api/auth/login?returnTo=%2Foverview");

  await page.goto("/login?returnTo=%2F%2Fevil.example");
  await expect(signIn).toHaveAttribute("href", "/api/auth/login?returnTo=%2Foverview");
});

test.describe("?error= states", () => {
  const alerts = ["idp_unreachable", "invalid_callback", "not_configured", "session_expired"] as const;
  for (const code of alerts) {
    test(`${code} is announced as an alert`, async ({ page }) => {
      await page.goto(`/login?error=${code}&returnTo=%2Ffindings`);
      const alert = page.getByRole("alert").filter({ hasText: en.login.notice[code].title });
      await expect(alert).toBeVisible();
      await expect(alert).toContainText(en.login.notice[code].description);
    });
  }

  test("a retry link is offered where trying again can help, and keeps the destination", async ({ page }) => {
    await page.goto("/login?error=idp_unreachable&returnTo=%2Ffindings");
    const alert = page.getByRole("alert").filter({ hasText: en.login.notice.idp_unreachable.title });
    await expect(alert.getByRole("link", { name: en.login.retry })).toHaveAttribute(
      "href",
      "/api/auth/login?returnTo=%2Ffindings",
    );

    await page.goto("/login?error=not_configured");
    const unavailable = page.getByRole("alert").filter({ hasText: en.login.notice.not_configured.title });
    await expect(unavailable.getByRole("link")).toHaveCount(0);
  });

  test("signed_out is a status, not an alert", async ({ page }) => {
    await page.goto("/login?error=signed_out");
    await expect(page.getByRole("status").filter({ hasText: en.login.notice.signed_out.title })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: en.login.notice.signed_out.title })).toHaveCount(0);
  });

  test("an unknown code renders the generic message and is never echoed", async ({ page }) => {
    const hostile = "<img src=x onerror=alert(1)>";
    await page.goto(`/login?error=${encodeURIComponent(hostile)}`);
    await expect(page.getByRole("alert").filter({ hasText: en.login.notice.unknown.title })).toBeVisible();
    // Neither as text nor as markup. (The URL itself legitimately appears, encoded, in Next's page payload.)
    await expect(page.locator("body")).not.toContainText("onerror", { useInnerText: true });
    await expect(page.locator("img[src='x']")).toHaveCount(0);
  });

  test("messages follow the locale", async ({ page, context }) => {
    await context.addCookies([{ name: "recon_locale", value: "ro", url: "http://localhost:3100" }]);
    await page.goto("/login?error=invalid_callback");
    await expect(page.locator("html")).toHaveAttribute("lang", "ro");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(ro.login.title);
    await expect(page.getByRole("alert").filter({ hasText: ro.login.notice.invalid_callback.title })).toBeVisible();
  });
});
