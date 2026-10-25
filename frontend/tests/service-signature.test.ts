import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalString,
  loadServiceKey,
  requestTarget,
  ServiceKeyError,
  signCanonical,
  signRequest,
} from "@/lib/service-signature";

// The very file the Rust verifier (crates/recon-api/src/service.rs) is tested against.
type Vector = {
  name: string;
  method: string;
  target: string;
  timestamp: string;
  nonce: string;
  body: string;
  canonical: string;
  signature: string;
};
const file = JSON.parse(
  readFileSync(resolve(__dirname, "../../crates/recon-api/tests/vectors/service-signature-v1.json"), "utf8"),
) as { key_id: string; secret_hex: string; secret_base64url: string; vectors: Vector[] };

const secret = Buffer.from(file.secret_hex, "hex");

describe("RECON-SVC-V1 shared vectors", () => {
  it("has the vectors the Rust side checks", () => {
    expect(file.vectors.length).toBeGreaterThanOrEqual(4);
  });

  it.each(file.vectors.map((v) => [v.name, v] as const))("canonicalises and signs %s exactly", (_name, v) => {
    const canonical = canonicalString({
      method: v.method,
      target: v.target,
      timestamp: v.timestamp,
      nonce: v.nonce,
      body: v.body,
    });
    expect(canonical).toBe(v.canonical);
    expect(signCanonical(secret, canonical)).toBe(v.signature);
  });

  it.each(file.vectors.map((v) => [v.name, v] as const))("signRequest reproduces %s", (_name, v) => {
    const url = new URL(v.target, "http://127.0.0.1:8081");
    const headers = signRequest(
      { keyId: file.key_id, secret },
      { method: v.method, url, body: Buffer.from(v.body, "utf8") },
      { nowSeconds: Number(v.timestamp), nonce: v.nonce },
    );
    expect(headers).toEqual({
      "x-recon-key-id": file.key_id,
      "x-recon-timestamp": v.timestamp,
      "x-recon-nonce": v.nonce,
      "x-recon-signature": v.signature,
    });
  });
});

describe("signRequest", () => {
  const key = { keyId: "bff-1", secret };
  const url = new URL("http://127.0.0.1:8081/v1/findings?limit=5");

  it("uses a fresh 16-byte base64url nonce and the current time", () => {
    const before = Math.floor(Date.now() / 1000);
    const a = signRequest(key, { method: "GET", url });
    const b = signRequest(key, { method: "GET", url });
    expect(a["x-recon-nonce"]).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a["x-recon-nonce"]).not.toBe(b["x-recon-nonce"]);
    expect(Number(a["x-recon-timestamp"])).toBeGreaterThanOrEqual(before);
    expect(a["x-recon-signature"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("changes the signature with the method, query and body", () => {
    const fixed = { nowSeconds: 1_700_000_000, nonce: "AAECAwQFBgcICQoLDA0ODw" };
    const base = signRequest(key, { method: "GET", url }, fixed)["x-recon-signature"];
    const other = (r: Parameters<typeof signRequest>[1]) => signRequest(key, r, fixed)["x-recon-signature"];
    expect(other({ method: "POST", url })).not.toBe(base);
    expect(other({ method: "GET", url: new URL("http://127.0.0.1:8081/v1/findings?limit=6") })).not.toBe(base);
    expect(other({ method: "GET", url, body: "x" })).not.toBe(base);
  });

  it("signs the path alone when the query is empty", () => {
    expect(requestTarget(new URL("http://h/v1/findings?"))).toBe("/v1/findings");
    expect(requestTarget(new URL("http://h/v1/findings"))).toBe("/v1/findings");
    expect(requestTarget(new URL("http://h/v1/findings?a=b%2Fc"))).toBe("/v1/findings?a=b%2Fc");
  });
});

describe("loadServiceKey", () => {
  const ok = { RECON_SERVICE_KEY_ID: "bff-1", RECON_SERVICE_KEY_SECRET: file.secret_base64url };

  it("reads a key id and a base64url secret of at least 32 bytes", () => {
    const key = loadServiceKey(ok);
    expect(key.keyId).toBe("bff-1");
    expect(key.secret.equals(secret)).toBe(true);
  });

  it.each<[Record<string, string | undefined>, string[]]>([
    [{ ...ok, RECON_SERVICE_KEY_ID: undefined }, ["RECON_SERVICE_KEY_ID"]],
    [{ ...ok, RECON_SERVICE_KEY_ID: "BFF" }, ["RECON_SERVICE_KEY_ID"]],
    [{ ...ok, RECON_SERVICE_KEY_ID: "a".repeat(33) }, ["RECON_SERVICE_KEY_ID"]],
    [{ ...ok, RECON_SERVICE_KEY_SECRET: undefined }, ["RECON_SERVICE_KEY_SECRET"]],
    [{ ...ok, RECON_SERVICE_KEY_SECRET: Buffer.alloc(31, 1).toString("base64url") }, ["RECON_SERVICE_KEY_SECRET"]],
    [{ ...ok, RECON_SERVICE_KEY_SECRET: "not base64url !!" }, ["RECON_SERVICE_KEY_SECRET"]],
    [{}, ["RECON_SERVICE_KEY_ID", "RECON_SERVICE_KEY_SECRET"]],
  ])("fails closed for %j", (env, variables) => {
    let thrown: unknown;
    try {
      loadServiceKey(env);
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(ServiceKeyError);
    expect((thrown as ServiceKeyError).variables).toEqual(variables);
    expect(String(thrown)).not.toContain(env.RECON_SERVICE_KEY_SECRET ?? "\u0000");
  });
});
