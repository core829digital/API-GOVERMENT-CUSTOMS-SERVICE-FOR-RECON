import { describe, expect, it } from "vitest";
import { loginPath, loginStartPath, parseLoginError } from "@/lib/auth/login-url";

describe("parseLoginError", () => {
  it.each(["idp_unreachable", "invalid_callback", "not_configured", "session_expired", "signed_out"])(
    "accepts the known code %s",
    (code) => {
      expect(parseLoginError(code)).toBe(code);
    },
  );

  it.each(["<script>", "IDP_UNREACHABLE", "idp_unreachable ", "access_denied"])(
    "maps the unknown value %j to the generic notice",
    (value) => {
      expect(parseLoginError(value)).toBe("unknown");
    },
  );

  it.each([null, undefined, ""])("shows no notice for %j", (value) => {
    expect(parseLoginError(value)).toBeNull();
  });
});

describe("login URLs", () => {
  it("encodes the return path", () => {
    expect(loginPath({ returnTo: "/batches/a?b=c&d=e" })).toBe("/login?returnTo=%2Fbatches%2Fa%3Fb%3Dc%26d%3De");
    expect(loginStartPath("/findings")).toBe("/api/auth/login?returnTo=%2Ffindings");
  });

  it("carries the error code and omits an empty query", () => {
    expect(loginPath({ error: "idp_unreachable" })).toBe("/login?error=idp_unreachable");
    expect(loginPath()).toBe("/login");
  });
});
