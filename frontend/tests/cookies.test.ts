import { NextResponse } from "next/server";
import { describe, expect, it } from "vitest";
import {
  cookieOptions,
  expiredCookieOptions,
  FLOW_COOKIE,
  SESSION_COOKIE,
} from "@/lib/auth/cookies";

function setCookieHeader(name: string, value: string, options: ReturnType<typeof cookieOptions>) {
  const response = new NextResponse(null);
  response.cookies.set(name, value, options);
  return response.headers.get("set-cookie") ?? "";
}

describe("session cookie flags (R-FE-4)", () => {
  const header = setCookieHeader(SESSION_COOKIE, "sealed", cookieOptions(900));
  const attributes = header.split(";").map((part) => part.trim().toLowerCase());

  it("is HttpOnly, Secure, SameSite=Lax, Path=/", () => {
    expect(attributes).toContain("httponly");
    expect(attributes).toContain("secure");
    expect(attributes).toContain("samesite=lax");
    expect(attributes).toContain("path=/");
  });

  it("satisfies the __Host- prefix rules: no Domain attribute", () => {
    expect(SESSION_COOKIE.startsWith("__Host-")).toBe(true);
    expect(FLOW_COOKIE.startsWith("__Host-")).toBe(true);
    expect(attributes.some((attribute) => attribute.startsWith("domain="))).toBe(false);
  });

  it("carries the requested lifetime", () => {
    expect(attributes).toContain("max-age=900");
  });

  it("deletion cookie keeps the same attributes and expires immediately", () => {
    const cleared = setCookieHeader(SESSION_COOKIE, "", expiredCookieOptions)
      .split(";")
      .map((part) => part.trim().toLowerCase());
    expect(cleared).toContain("max-age=0");
    expect(cleared).toContain("httponly");
    expect(cleared).toContain("secure");
    expect(cleared).toContain("samesite=lax");
  });

  it("never emits a negative or fractional Max-Age", () => {
    expect(cookieOptions(-5).maxAge).toBe(0);
    expect(cookieOptions(10.9).maxAge).toBe(10);
  });
});
