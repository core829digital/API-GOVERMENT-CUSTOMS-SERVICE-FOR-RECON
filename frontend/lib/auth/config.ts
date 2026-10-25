import { parseSecret } from "./seal";

export type AuthConfig = {
  issuer: URL;
  clientId: string;
  /** Absent for a public client; PKCE is used either way. */
  clientSecret: string | undefined;
  redirectUri: URL;
  scope: string;
  sessionKey: Uint8Array;
};

const REQUIRED = ["OIDC_ISSUER", "OIDC_CLIENT_ID", "APP_BASE_URL", "SESSION_SECRET"] as const;

export class AuthConfigError extends Error {
  /** Names of the missing/invalid variables; never their values. */
  readonly variables: string[];

  constructor(variables: string[]) {
    super("auth_not_configured");
    this.name = "AuthConfigError";
    this.variables = variables;
  }
}

export function loadAuthConfig(
  env: Record<string, string | undefined> = process.env,
): AuthConfig {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length > 0) throw new AuthConfigError(missing);

  const invalid: string[] = [];
  let issuer: URL | undefined;
  let redirectUri: URL | undefined;
  let sessionKey: Uint8Array | undefined;
  try {
    issuer = new URL(env.OIDC_ISSUER!);
  } catch {
    invalid.push("OIDC_ISSUER");
  }
  try {
    redirectUri = new URL("/api/auth/callback", env.APP_BASE_URL!);
  } catch {
    invalid.push("APP_BASE_URL");
  }
  try {
    sessionKey = parseSecret(env.SESSION_SECRET!);
  } catch {
    invalid.push("SESSION_SECRET");
  }
  if (!issuer || !redirectUri || !sessionKey) throw new AuthConfigError(invalid);

  return {
    issuer,
    clientId: env.OIDC_CLIENT_ID!,
    clientSecret: env.OIDC_CLIENT_SECRET || undefined,
    redirectUri,
    scope: env.OIDC_SCOPE || "openid",
    sessionKey,
  };
}
