import { EncryptJWT, jwtDecrypt } from "jose";

export type Purpose = "session" | "flow";

export type SessionPayload = {
  accessToken: string;
  /** Unix seconds. */
  expiresAt: number;
};

export type FlowPayload = {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
};

const ISSUER = "recon-frontend";

/** `SESSION_SECRET` is the base64url encoding of exactly 32 random bytes (AES-256-GCM key). */
export function parseSecret(encoded: string): Uint8Array {
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== 32) {
    throw new Error("session_secret_invalid");
  }
  return new Uint8Array(key);
}

/**
 * Encrypts and authenticates the payload (JWE, `dir` + A256GCM). The audience binds the
 * token to one purpose so a flow cookie can never be accepted as a session cookie.
 * `expiresAt` is Unix seconds.
 */
export async function seal(
  purpose: Purpose,
  payload: Record<string, unknown>,
  key: Uint8Array,
  expiresAt: number,
): Promise<string> {
  return new EncryptJWT(payload)
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuer(ISSUER)
    .setAudience(purpose)
    .setExpirationTime(expiresAt)
    .encrypt(key);
}

/** Returns `null` for any tampered, expired, wrong-purpose or malformed token. */
export async function unseal(
  purpose: Purpose,
  token: string,
  key: Uint8Array,
): Promise<Record<string, unknown> | null> {
  try {
    const { payload } = await jwtDecrypt(token, key, {
      issuer: ISSUER,
      audience: purpose,
      keyManagementAlgorithms: ["dir"],
      contentEncryptionAlgorithms: ["A256GCM"],
    });
    return payload;
  } catch {
    return null;
  }
}
