import { expect, test, type Locator, type Page } from "@playwright/test";
import { en } from "./catalogs";
import { signIn } from "./session";

declare global {
  interface Window {
    __probe: { samples: number[]; classes: Set<string>; wheelPrevented: boolean[] };
  }
}

/** Pages that mount Lenis: the public site layout and the console overview layout. */
const smoothScrolled = [
  { name: "site home", path: "/", authenticated: false },
  { name: "console overview", path: "/overview", authenticated: true },
] as const;

/** Samples window.scrollY on every frame and records every class Lenis puts on <html>. */
async function startRecording(page: Page) {
  await page.evaluate(() => {
    window.__probe = { samples: [], classes: new Set(), wheelPrevented: [] };
    const record = () => {
      window.__probe.samples.push(window.scrollY);
      document.documentElement.classList.forEach((c) => window.__probe.classes.add(c));
      requestAnimationFrame(record);
    };
    requestAnimationFrame(record);
  });
}

async function readRecording(page: Page) {
  return page.evaluate(() => ({
    samples: [...window.__probe.samples],
    classes: [...window.__probe.classes],
    final: window.scrollY,
  }));
}

async function wheelOn(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator("html.lenis")).toBeAttached();
  await startRecording(page);
  await page.mouse.move(600, 150);
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(1500);
  return readRecording(page);
}

test.describe("Lenis honours prefers-reduced-motion (R-FE-1)", () => {
  test.use({ viewport: { width: 1280, height: 300 } });

  for (const target of smoothScrolled) {
    test.describe(`reduce: ${target.name}`, () => {
      test.use({ reducedMotion: "reduce" });

      test("scroll tracks the wheel 1:1 instead of being interpolated", async ({ page, context }) => {
        if (target.authenticated) await signIn(context);
        const { samples, classes, final } = await wheelOn(page, target.path);
        const intermediateFrames = samples.filter((y) => y > 0 && y < final).length;
        expect(final).toBeGreaterThan(0);
        // Observable: Lenis 1.3.27 forces lerp=1 under reduced motion, which in its damping
        // function settles within a few frames (measured: 5 frames, ~70 ms). It still adds the
        // lenis-smooth class while doing so, so the class is not a usable signal.
        expect(classes).toContain("lenis");
        expect(intermediateFrames).toBeLessThanOrEqual(10);
      });
    });

    test.describe(`no-preference (control): ${target.name}`, () => {
      test.use({ reducedMotion: "no-preference" });

      test("scroll is interpolated over several frames", async ({ page, context }) => {
        if (target.authenticated) await signIn(context);
        const { samples, classes, final } = await wheelOn(page, target.path);
        const intermediateFrames = samples.filter((y) => y > 0 && y < final).length;
        expect(final).toBeGreaterThan(0);
        expect(classes).toContain("lenis-smooth");
        // Measured: 57 frames, ~765 ms for the same wheel input.
        expect(intermediateFrames).toBeGreaterThanOrEqual(30);
      });
    });
  }
});

test.describe("nested scrollers are excluded from Lenis (R-FE-1)", () => {
  test.use({ viewport: { width: 390, height: 110 }, reducedMotion: "no-preference" });

  async function openNavigationSheet(page: Page) {
    await page.goto("/overview");
    await expect(page.locator("html.lenis")).toBeAttached();
    await page.getByRole("button", { name: en.shell.toggleSidebar }).click();
    const dialog = page.getByRole("dialog", { name: en.shell.sidebarTitle });
    await expect(dialog).toBeVisible();
    // Wait for the slide-in animation to finish so the wheel lands on the list, not on the page behind it.
    await expect.poll(async () => (await dialog.boundingBox())?.x).toBe(0);
    return dialog;
  }

  /** Wheels over the middle of `list` and reports whether the page handler (Lenis) cancelled it. */
  async function wheelOver(page: Page, list: Locator) {
    await startRecording(page);
    await page.evaluate(() => {
      // Registered after Lenis' own window listener, so it observes the final defaultPrevented state.
      window.addEventListener("wheel", (event) => window.__probe.wheelPrevented.push(event.defaultPrevented), { passive: true });
    });
    const box = (await list.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 40);
    await page.waitForTimeout(800);
    return page.evaluate(() => window.__probe.wheelPrevented);
  }

  test.beforeEach(async ({ context }) => {
    await signIn(context);
  });

  test("a Radix dialog with an overflowing list scrolls natively while Lenis is active", async ({ page }) => {
    const dialog = await openNavigationSheet(page);
    const list = dialog.locator("[data-sidebar='content']");
    await expect(dialog).toHaveAttribute("data-lenis-prevent", "");
    await expect(list).toHaveAttribute("data-lenis-prevent", "");

    const metrics = await list.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);

    const prevented = await wheelOver(page, list);
    expect(prevented.length).toBeGreaterThan(0);
    expect(prevented.every((p) => !p)).toBe(true);
    expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  });

  test("control: without data-lenis-prevent Lenis cancels the wheel and the list does not scroll", async ({ page }) => {
    const dialog = await openNavigationSheet(page);
    const list = dialog.locator("[data-sidebar='content']");
    await page.evaluate(() => document.querySelectorAll("[data-lenis-prevent]").forEach((el) => el.removeAttribute("data-lenis-prevent")));

    const prevented = await wheelOver(page, list);
    expect(prevented.some((p) => p)).toBe(true);
    expect(await list.evaluate((el) => el.scrollTop)).toBe(0);
  });
});

test.describe("scoping and markers", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("Lenis runs on the public site and the overview layout, not on the data-table layout", async ({ page, context }) => {
    await page.goto("/");
    await expect(page.locator("html.lenis")).toBeAttached();

    await signIn(context);
    await page.goto("/overview");
    await expect(page.locator("html.lenis")).toBeAttached();
    await page.getByRole("link", { name: en.shell.nav.findings, exact: true }).first().click();
    await expect(page).toHaveURL(/\/findings$/);
    await expect(page.getByRole("heading", { level: 1, name: en.findings.title })).toBeVisible();
    await expect(page.locator("html.lenis")).toHaveCount(0);

    await page.goto("/findings");
    await expect(page.locator("html.lenis")).toHaveCount(0);
  });

  test("the sign-in page has no Lenis", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator("html.lenis")).toHaveCount(0);
  });

  test("popover content carries data-lenis-prevent", async ({ page, context }) => {
    await signIn(context);
    await page.goto("/overview");
    await page.getByRole("button", { name: en.shell.theme.label }).click();
    await expect(page.getByRole("menu")).toHaveAttribute("data-lenis-prevent", "");
  });

  test("the findings table scroll region carries data-lenis-prevent", async ({ page, context }) => {
    await signIn(context);
    // Test fixture: the API does not exist yet, so the table is only reachable with a response in hand.
    await page.route("**/api/bff/v1/findings", (route) =>
      route.fulfill({
        json: {
          items: [
            {
              finding_id: "0190c1f2-0000-7000-8000-000000000001",
              check_code: "C1",
              severity: "high",
              jurisdiction: "RO",
              summary: "fixture",
              rule_citation: "fixture",
              created_at: "2026-10-01T10:00:00Z",
            },
          ],
        },
      }),
    );
    await page.goto("/findings");
    await expect(page.getByRole("region", { name: en.findings.tableLabel })).toHaveAttribute("data-lenis-prevent", "");
  });
});
