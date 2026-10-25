import { describe, expect, it } from "vitest";
import { decideGate, isProtectedPath } from "@/lib/auth/gate";

const base = { search: "", configured: true, authenticated: false } as const;

describe("isProtectedPath", () => {
  it.each(["/overview", "/findings", "/batches/0190c1f2", "/overview/"])("protects %s", (path) => {
    expect(isProtectedPath(path)).toBe(true);
  });

  it.each(["/", "/login", "/platform", "/api/auth/session", "/overviewer", "/findings-archive"])(
    "leaves %s alone",
    (path) => {
      expect(isProtectedPath(path)).toBe(false);
    },
  );
});

describe("decideGate", () => {
  it("lets public paths through without a session", () => {
    expect(decideGate({ ...base, pathname: "/trust" })).toEqual({ action: "allow" });
  });

  it("lets a signed-in visitor through", () => {
    expect(decideGate({ ...base, pathname: "/findings", authenticated: true })).toEqual({ action: "allow" });
  });

  it("sends an anonymous visitor to the sign-in page and remembers path and query", () => {
    expect(decideGate({ ...base, pathname: "/batches/abc", search: "?tab=1" })).toEqual({
      action: "redirect",
      path: "/login?returnTo=%2Fbatches%2Fabc%3Ftab%3D1",
    });
  });

  it("drops Next's internal RSC parameter from the remembered destination", () => {
    expect(decideGate({ ...base, pathname: "/findings", search: "?_rsc=1x2y" })).toEqual({
      action: "redirect",
      path: "/login?returnTo=%2Ffindings",
    });
  });

  it("reports missing configuration instead of a return path", () => {
    expect(decideGate({ ...base, pathname: "/overview", configured: false, authenticated: true })).toEqual({
      action: "redirect",
      path: "/login?error=not_configured",
    });
  });
});
