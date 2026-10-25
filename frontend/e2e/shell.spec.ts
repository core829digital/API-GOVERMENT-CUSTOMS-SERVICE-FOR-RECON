import { expect, test } from "@playwright/test";
import { en, ro } from "./catalogs";
import { ORIGIN, signIn } from "./session";

// The OS asks for a light scheme on purpose: the product default is dark and must not follow the OS.
test.use({ viewport: { width: 1280, height: 800 }, colorScheme: "light" });

test("language switcher persists the locale and re-renders in Romanian", async ({ page }) => {
  await page.goto("/login");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(en.login.title);

  await page.getByRole("button", { name: en.shell.language.label }).click();
  await page.getByRole("menuitemradio", { name: ro.shell.language.ro }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "ro");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(ro.login.title);

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "ro");
});

test("the theme is dark by default, even when the OS prefers light", async ({ page }) => {
  await page.goto("/login");
  await expect(page.locator("html")).toHaveClass(/dark/);
});

test("theme toggle switches the dark class and remembers the choice", async ({ page }) => {
  // Explicit starting point: do not depend on the default.
  await page.addInitScript(() => window.localStorage.setItem("theme", "light"));
  await page.goto("/login");
  await expect(page.locator("html")).not.toHaveClass(/dark/);

  await page.getByRole("button", { name: en.shell.theme.label }).click();
  await page.getByRole("menuitemradio", { name: en.shell.theme.dark }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  // The closing menu is still animating out; reopening it before it is gone would race with its own exit.
  await expect(page.getByRole("menu")).toHaveCount(0);

  await page.getByRole("button", { name: en.shell.theme.label }).click();
  await page.getByRole("menuitemradio", { name: en.shell.theme.light }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
});

test("the browser only ever calls same-origin /api/bff and never sees a bearer token", async ({ page, context }) => {
  await signIn(context);
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));

  await page.goto("/findings");
  // The API is deliberately unreachable in this run, so the BFF answers 502 and the table shows its error state.
  await expect(page.getByRole("alert").filter({ hasText: en.errors.unavailable.title })).toBeVisible();

  const apiCalls = requests.filter((url) => url.includes("/v1/"));
  expect(apiCalls.length).toBeGreaterThan(0);
  for (const url of apiCalls) {
    expect(new URL(url).origin).toBe(ORIGIN);
    expect(new URL(url).pathname.startsWith("/api/bff/v1/")).toBe(true);
  }
  // The session cookie is HttpOnly: scripts see nothing.
  expect(await page.evaluate(() => document.cookie)).toBe("");
});

test("without a session the BFF answers 401 and does not reach the API", async ({ request }) => {
  const response = await request.get("/api/bff/v1/findings");
  expect(response.status()).toBe(401);
  expect(await response.json()).toEqual({ error: "unauthenticated" });
});

test("the BFF refuses paths outside /v1 and non-GET methods", async ({ request }) => {
  expect((await request.get("/api/bff/v2/findings")).status()).toBe(400);
  expect((await request.post("/api/bff/v1/batches", { data: {} })).status()).toBe(405);
});

test("session endpoint reports no session without a cookie", async ({ request }) => {
  const response = await request.get("/api/auth/session");
  expect(await response.json()).toEqual({ authenticated: false });
  expect(response.headers()["cache-control"]).toBe("no-store");
});

test("session endpoint reports a session for a valid cookie", async ({ page, context }) => {
  await signIn(context);
  const response = await page.request.get("/api/auth/session");
  expect(await response.json()).toEqual({ authenticated: true });
});
