import { createHash, createHmac, randomBytes } from "node:crypto";

/**
 * Signer for the API's internal listener, scheme `RECON-SVC-V1`. Server-only: it uses `node:crypto` and a secret
 * that must never reach a browser bundle (the only importer is the BFF route handler).
 *
 *   canonical = "RECON-SVC-V1\n" METHOD "\n" TARGET "\n" TIMESTAMP "\n" NONCE "\n" lower-hex(SHA-256(body))
 *   signature = base64url(HMAC-SHA256(secret, canonical))
 *
 * `TARGET` is the path plus `?query` (raw, still percent-encoded) when the query is non-empty. The Rust verifier is
 * `crates/recon-api/src/service.rs`; both are tested against `crates/recon-api/tests/vectors/service-signature-v1.json`.
 */

export const SCHEME = "RECON-SVC-V1";

const KEY_ID = /^[a-z0-9-]{1,32}$/;
const MIN_SECRET_BYTES = 32;

export type ServiceKey = { readonly keyId: string; readonly secret: Buffer };

export class ServiceKeyError extends Error {
  constructor(readonly variables: readonly string[]) {
    super("service signing key is missing or invalid");
    this.name = "ServiceKeyError";
  }
}

/** `RECON_SERVICE_KEY_ID` and `RECON_SERVICE_KEY_SECRET` (base64url, at least 32 bytes). Never logs the secret. */
export function loadServiceKey(env: Record<string, string | undefined> = process.env): ServiceKey {
  const keyId = env.RECON_SERVICE_KEY_ID ?? "";
  const encoded = env.RECON_SERVICE_KEY_SECRET ?? "";
  const bad: string[] = [];
  if (!KEY_ID.test(keyId)) bad.push("RECON_SERVICE_KEY_ID");
  const secret = /^[A-Za-z0-9_-]+$/.test(encoded) ? Buffer.from(encoded, "base64url") : Buffer.alloc(0);
  if (secret.length < MIN_SECRET_BYTES) bad.push("RECON_SERVICE_KEY_SECRET");
  if (bad.length > 0) throw new ServiceKeyError(bad);
  return { keyId, secret };
}

export function canonicalString(input: {
  method: string;
  target: string;
  timestamp: string;
  nonce: string;
  body: Uint8Array | string;
}): string {
  const bodyHash = createHash("sha256").update(input.body).digest("hex");
  return [SCHEME, input.method.toUpperCase(), input.target, input.timestamp, input.nonce, bodyHash].join("\n");
}

export function signCanonical(secret: Uint8Array, canonical: string): string {
  return createHmac("sha256", secret).update(canonical).digest("base64url");
}

/** What the server signs: `pathname` plus `search` when the query is non-empty. */
export function requestTarget(url: URL): string {
  return url.search.length > 1 ? `${url.pathname}${url.search}` : url.pathname;
}

/** The four `X-Recon-*` headers for one request. `now` and `nonce` are injectable for tests only. */
export function signRequest(
  key: ServiceKey,
  request: { method: string; url: URL; body?: Uint8Array | string },
  overrides: { nowSeconds?: number; nonce?: string } = {},
): Record<string, string> {
  const timestamp = String(overrides.nowSeconds ?? Math.floor(Date.now() / 1000));
  const nonce = overrides.nonce ?? randomBytes(16).toString("base64url");
  const canonical = canonicalString({
    method: request.method,
    target: requestTarget(request.url),
    timestamp,
    nonce,
    body: request.body ?? "",
  });
  return {
    "x-recon-key-id": key.keyId,
    "x-recon-timestamp": timestamp,
    "x-recon-nonce": nonce,
    "x-recon-signature": signCanonical(key.secret, canonical),
  };
}
