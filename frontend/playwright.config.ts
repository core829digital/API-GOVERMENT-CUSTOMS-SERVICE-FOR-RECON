import { randomBytes } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
const baseURL = `http://localhost:${PORT}`;

// One throwaway key per run, shared with the workers through the environment (they inherit it from this
// process, and `??=` keeps it when they re-evaluate this file). Tests seal their own session cookies with it
// (`e2e/session.ts`); nothing here is a secret.
const sessionSecret = (process.env.E2E_SESSION_SECRET ??= randomBytes(32).toString("base64url"));

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  reporter: [["list"]],
  use: { baseURL, ...devices["Desktop Chrome"] },
  projects: [{ name: "chromium" }],
  webServer: {
    // Serves the production build; run `npm run build` first.
    command: `npm run start -- --port ${PORT}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      // Throwaway values so the BFF is "configured": there is no IdP, so no one can really sign in; tests that
      // need a session forge one with the key above. Pages render their real unauthenticated state otherwise.
      SESSION_SECRET: sessionSecret,
      OIDC_ISSUER: "https://idp.invalid",
      OIDC_CLIENT_ID: "recon-e2e",
      APP_BASE_URL: baseURL,
      RECON_API_BASE_URL: "http://127.0.0.1:9",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
