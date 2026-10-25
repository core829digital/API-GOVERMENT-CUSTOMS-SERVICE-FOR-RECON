import { expect, test } from "@playwright/test";
import { locales } from "../i18n/config";
import { catalogs, en } from "./catalogs";
import { ORIGIN } from "./session";

const publicPaths = ["/", "/platform", "/checks", "/trust", "/login"];

test.describe("every language renders every public page without horizontal overflow", () => {
  // 360 px is the narrowest supported viewport; German, Dutch and Polish compounds are the likeliest to break it.
  test.use({ viewport: { width: 360, height: 740 }, reducedMotion: "reduce" });

  for (const locale of locales) {
    for (const path of publicPaths) {
      test(`${locale} ${path}`, async ({ page, context }) => {
        await context.addCookies([{ name: "recon_locale", value: locale, url: ORIGIN }]);
        await page.goto(path);
        await expect(page.locator("html")).toHaveAttribute("lang", locale);
        await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
        const widths = await page.evaluate(() => ({
          scroll: document.documentElement.scrollWidth,
          client: document.documentElement.clientWidth,
        }));
        expect(widths.scroll).toBeLessThanOrEqual(widths.client);
      });
    }
  }
});

test.describe("the first visit follows the browser language", () => {
  // Playwright's `locale` option sets the Accept-Language header. No cookie exists yet in a fresh context.
  const cases: { header: string; expected: (typeof locales)[number] }[] = [
    { header: "nl-BE", expected: "nl" },
    { header: "fr-BE", expected: "fr" },
    { header: "de-AT", expected: "de" },
    { header: "pl-PL", expected: "pl" },
    { header: "it-CH", expected: "it" },
    { header: "es-MX", expected: "es" },
    { header: "pt-BR", expected: "en" },
  ];
  for (const { header, expected } of cases) {
    test.describe(header, () => {
      test.use({ locale: header });
      test(`lands on ${expected}`, async ({ page }) => {
        await page.goto("/login");
        await expect(page.locator("html")).toHaveAttribute("lang", expected);
        await expect(page.getByRole("heading", { level: 1 })).toHaveText(catalogs[expected].login.title);
      });
    });
  }

  test("an explicit choice beats the browser language", async ({ page, context }) => {
    await context.addCookies([{ name: "recon_locale", value: "ro", url: ORIGIN }]);
    await page.goto("/login");
    await expect(page.locator("html")).toHaveAttribute("lang", "ro");
  });
});

test.describe("the language menu", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("offers all supported languages by their own names and switches the page", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: en.shell.language.label }).click();
    for (const locale of locales) {
      await expect(page.getByRole("menuitemradio", { name: en.shell.language[locale] })).toBeVisible();
    }
    await page.getByRole("menuitemradio", { name: en.shell.language.pl }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "pl");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(catalogs.pl.login.title);
  });
});

test.describe("the not-found page is localized", () => {
  for (const locale of locales) {
    test(locale, async ({ page, context }) => {
      await context.addCookies([{ name: "recon_locale", value: locale, url: ORIGIN }]);
      const response = await page.goto("/there-is-no-such-page");
      expect(response?.status()).toBe(404);
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(catalogs[locale].pages.notFound.title);
    });
  }
});
