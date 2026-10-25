import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { locales } from "../i18n/config";
import { catalogs, en } from "./catalogs";
import { ORIGIN, signIn } from "./session";

type Catalog = typeof en;

// Test fixture: the API does not exist yet, so the populated table is only reachable with a response in hand.
// A 401 from the BFF is likewise forged: the gate keeps a visitor without a session off the console, so the
// in-page "sign in required" state only occurs when the API rejects an otherwise valid session.
const fixtureFindings = {
  items: [
    {
      finding_id: "0190c1f2-0000-7000-8000-000000000001",
      check_code: "C1",
      severity: "high",
      jurisdiction: "RO",
      summary: "Invoice totals in the books differ from the authority copy.",
      rule_citation: "Fixture citation, art. 1",
      created_at: "2026-10-01T10:00:00Z",
    },
    {
      finding_id: "0190c1f2-0000-7000-8000-000000000002",
      check_code: "C2",
      severity: "info",
      jurisdiction: null,
      summary: "Period missing in the authority copy.",
      rule_citation: "Fixture citation, art. 2",
      created_at: "2026-10-02T10:00:00Z",
    },
    {
      finding_id: "0190c1f2-0000-7000-8000-000000000003",
      check_code: "C3",
      severity: "medium",
      jurisdiction: "RO",
      summary: "Fixture row with medium severity.",
      rule_citation: "Fixture citation, art. 3",
      created_at: "2026-10-03T10:00:00Z",
    },
    {
      finding_id: "0190c1f2-0000-7000-8000-000000000004",
      check_code: "C4",
      severity: "low",
      jurisdiction: "RO",
      summary: "Fixture row with low severity.",
      rule_citation: "Fixture citation, art. 4",
      created_at: "2026-10-04T10:00:00Z",
    },
  ],
};

const batchId = "0190c1f2-0000-7000-8000-0000000000aa";

async function audit(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  console.log(
    `axe ${page.url()} ${await page.evaluate(() => document.documentElement.className || "-")}: ` +
      `${violations.length} violations (${blocking.length} serious/critical)` +
      violations.map((v) => ` [${v.impact}:${v.id}]`).join(""),
  );
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
}

type Entry = {
  name: string;
  path: string;
  /** Needs a session cookie to get past the console gate. */
  authenticated?: boolean;
  /** Forges BFF responses before navigation. */
  fixture?: (page: Page) => Promise<unknown>;
  ready: (page: Page, m: Catalog) => Promise<void>;
};

const h1Visible = async (page: Page) => {
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
};

const unauthorisedByApi = (page: Page) =>
  page.route("**/api/bff/v1/**", (route) => route.fulfill({ status: 401, json: { error: "unauthenticated" } }));

const pages: Entry[] = [
  { name: "home", path: "/", ready: h1Visible },
  { name: "platform", path: "/platform", ready: h1Visible },
  { name: "checks", path: "/checks", ready: h1Visible },
  { name: "trust", path: "/trust", ready: h1Visible },
  { name: "sign-in", path: "/login", ready: h1Visible },
  {
    name: "sign-in (idp_unreachable)",
    path: "/login?error=idp_unreachable",
    ready: async (page, m) => {
      await expect(page.getByRole("alert").filter({ hasText: m.login.notice.idp_unreachable.title })).toBeVisible();
    },
  },
  {
    name: "sign-in (session_expired)",
    path: "/login?error=session_expired&returnTo=%2Ffindings",
    ready: async (page, m) => {
      await expect(page.getByRole("alert").filter({ hasText: m.login.notice.session_expired.title })).toBeVisible();
    },
  },
  {
    name: "sign-in (signed_out)",
    path: "/login?error=signed_out",
    ready: async (page, m) => {
      await expect(page.getByRole("status").filter({ hasText: m.login.notice.signed_out.title })).toBeVisible();
    },
  },
  { name: "overview", path: "/overview", authenticated: true, ready: h1Visible },
  {
    name: "findings (API rejects the session)",
    path: "/findings",
    authenticated: true,
    fixture: unauthorisedByApi,
    ready: async (page, m) => {
      await expect(page.getByRole("alert").filter({ hasText: m.errors.unauthenticated.title })).toBeVisible();
    },
  },
  {
    name: "findings (API unavailable)",
    path: "/findings",
    authenticated: true,
    ready: async (page, m) => {
      await expect(page.getByRole("alert").filter({ hasText: m.errors.unavailable.title })).toBeVisible();
    },
  },
  {
    name: "findings (populated table, fixture)",
    path: "/findings",
    authenticated: true,
    fixture: (page) => page.route("**/api/bff/v1/findings", (route) => route.fulfill({ json: fixtureFindings })),
    ready: async (page) => {
      await expect(page.getByRole("table")).toBeVisible();
    },
  },
  {
    name: "batch status (API rejects the session)",
    path: `/batches/${batchId}`,
    authenticated: true,
    fixture: unauthorisedByApi,
    ready: async (page, m) => {
      await expect(page.getByRole("alert").filter({ hasText: m.errors.unauthenticated.title })).toBeVisible();
    },
  },
  {
    name: "batch status (invalid id)",
    path: "/batches/not-a-uuid",
    authenticated: true,
    ready: async (page, m) => {
      await expect(page.getByRole("alert").filter({ hasText: m.errors.notFound.title })).toBeVisible();
    },
  },
];

for (const scheme of ["light", "dark"] as const) {
  for (const locale of locales) {
    test.describe(`axe: ${scheme} / ${locale}`, () => {
      // Reduced motion: reveal transitions would otherwise leave text semi-transparent mid-fade, and axe would
      // measure contrast against that. The reduced-motion presentation is what content looks like at rest.
      test.use({ colorScheme: scheme, viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });

      for (const entry of pages) {
        test(entry.name, async ({ page, context }) => {
          await context.addCookies([{ name: "recon_locale", value: locale, url: ORIGIN }]);
          // The theme is explicit: the product default is dark, whatever the OS scheme says.
          await page.addInitScript((theme) => window.localStorage.setItem("theme", theme), scheme);
          if (entry.authenticated) await signIn(context);
          await entry.fixture?.(page);
          await page.goto(entry.path);
          await expect(page.locator("html")).toHaveAttribute("lang", locale);
          await expect(page.locator("html")).toHaveClass(scheme === "dark" ? /dark/ : /^(?!.*dark)/);
          await entry.ready(page, catalogs[locale]);
          await audit(page);
        });
      }
    });
  }
}

test.describe("every page has exactly one h1", () => {
  test.use({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });

  for (const entry of pages.filter((p) => !p.fixture)) {
    test(entry.name, async ({ page, context }) => {
      if (entry.authenticated) await signIn(context);
      await page.goto(entry.path);
      await entry.ready(page, en);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    });
  }

  test("findings table (fixture)", async ({ page, context }) => {
    await signIn(context);
    await page.route("**/api/bff/v1/findings", (route) => route.fulfill({ json: fixtureFindings }));
    await page.goto("/findings");
    await expect(page.getByRole("table")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  });
});

test.describe("axe: open overlays", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("theme menu open", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: en.shell.theme.label }).click();
    await expect(page.getByRole("menu")).toBeFocused();
    await audit(page);
  });

  test("mobile navigation sheet open", async ({ page, context }) => {
    await signIn(context);
    await page.setViewportSize({ width: 390, height: 700 });
    await page.goto("/overview");
    await page.getByRole("button", { name: en.shell.toggleSidebar }).click();
    await expect(page.getByRole("dialog", { name: en.shell.sidebarTitle })).toBeVisible();
    await audit(page);
  });
});
