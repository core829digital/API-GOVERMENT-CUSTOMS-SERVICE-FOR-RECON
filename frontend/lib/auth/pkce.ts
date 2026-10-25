import { createHash, randomBytes } from "node:crypto";

/** 32 random bytes, base64url without padding: 43 characters, the RFC 7636 §4.1 minimum. */
function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export const generateCodeVerifier = randomToken;
export const generateState = randomToken;
export const generateNonce = randomToken;

/** RFC 7636 §4.2: `code_challenge = BASE64URL(SHA256(ASCII(code_verifier)))`. */
export function codeChallengeS256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}
