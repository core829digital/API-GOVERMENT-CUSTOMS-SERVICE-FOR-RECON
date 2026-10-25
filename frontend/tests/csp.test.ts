import { describe, expect, it } from "vitest";
import { buildCsp, newNonce } from "@/lib/csp";

function directive(csp: string, name: string): string[] {
  const found = csp.split("; ").find((d) => d === name || d.startsWith(`${name} `));
  return found ? found.split(" ").slice(1) : [];
}

describe("buildCsp", () => {
  const csp = buildCsp("abc123", { development: false });

  it("allows scripts only by nonce, with no inline or eval escape hatch", () => {
    const script = directive(csp, "script-src");
    expect(script).toContain("'nonce-abc123'");
    expect(script).toContain("'strict-dynamic'");
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
  });

  it("allows inline styles (the CSSOM needs them) but no external style origin", () => {
    expect(directive(csp, "style-src")).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it("closes plugins, base, forms and framing, and upgrades plain HTTP in production", () => {
    expect(directive(csp, "object-src")).toEqual(["'none'"]);
    expect(directive(csp, "base-uri")).toEqual(["'self'"]);
    expect(directive(csp, "form-action")).toEqual(["'self'"]);
    expect(directive(csp, "frame-ancestors")).toEqual(["'none'"]);
    expect(directive(csp, "default-src")).toEqual(["'self'"]);
    expect(csp.split("; ")).toContain("upgrade-insecure-requests");
  });

  it("adds eval only for development, and no HTTPS upgrade there", () => {
    const dev = buildCsp("abc123", { development: true });
    expect(directive(dev, "script-src")).toContain("'unsafe-eval'");
    expect(dev).not.toContain("upgrade-insecure-requests");
  });
});

describe("newNonce", () => {
  it("is 128 random bits in base64 and differs per call", () => {
    const a = newNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(newNonce()).not.toBe(a);
  });
});
