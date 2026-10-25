import { describe, expect, it } from "vitest";
import {
  codeChallengeS256,
  generateCodeVerifier,
  generateNonce,
  generateState,
} from "@/lib/auth/pkce";

describe("PKCE / state / nonce", () => {
  it("S256 challenge matches the RFC 7636 Appendix B test vector", () => {
    expect(codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("verifier is 43-128 unreserved characters (RFC 7636 §4.1)", () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  });

  it("state, nonce and verifier are unpredictable: no collisions in 1000 draws", () => {
    const draws = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      draws.add(generateState());
      draws.add(generateNonce());
      draws.add(generateCodeVerifier());
    }
    expect(draws.size).toBe(3000);
  });

  it("challenge is base64url without padding and differs from the verifier", () => {
    const verifier = generateCodeVerifier();
    const challenge = codeChallengeS256(verifier);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).not.toBe(verifier);
  });
});
