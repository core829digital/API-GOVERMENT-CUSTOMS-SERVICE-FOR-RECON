import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AuthConfigError, loadAuthConfig } from "@/lib/auth/config";

const valid = () => ({
  OIDC_ISSUER: "https://idp.example",
  OIDC_CLIENT_ID: "recon-web",
  APP_BASE_URL: "https://app.example",
  SESSION_SECRET: randomBytes(32).toString("base64url"),
});

describe("loadAuthConfig", () => {
  it("builds the callback URL from APP_BASE_URL and defaults the scope to openid", () => {
    const config = loadAuthConfig(valid());
    expect(config.redirectUri.href).toBe("https://app.example/api/auth/callback");
    expect(config.scope).toBe("openid");
    expect(config.clientSecret).toBeUndefined();
  });

  it("names every missing variable and never includes values", () => {
    try {
      loadAuthConfig({ SESSION_SECRET: "secret-material" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AuthConfigError);
      const { variables, message } = error as AuthConfigError;
      expect(variables).toEqual(["OIDC_ISSUER", "OIDC_CLIENT_ID", "APP_BASE_URL"]);
      expect(message).not.toContain("secret-material");
    }
  });

  it("rejects a SESSION_SECRET that is not 32 bytes", () => {
    expect(() => loadAuthConfig({ ...valid(), SESSION_SECRET: "short" })).toThrow(AuthConfigError);
  });
});
