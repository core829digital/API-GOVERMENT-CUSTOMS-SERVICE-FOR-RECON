import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseSecret, seal, unseal } from "@/lib/auth/seal";
import { openSession, sealSession } from "@/lib/auth/session";

const now = () => Math.floor(Date.now() / 1000);
const key = () => new Uint8Array(randomBytes(32));

describe("sealed cookies", () => {
  it("round-trips a session", async () => {
    const k = key();
    const payload = { accessToken: "token-value", expiresAt: now() + 300 };
    const sealed = await sealSession(payload, k);
    expect(sealed).not.toContain("token-value");
    expect(await openSession(sealed, k)).toEqual(payload);
  });

  it("rejects a token sealed with another key", async () => {
    const sealed = await sealSession({ accessToken: "t", expiresAt: now() + 300 }, key());
    expect(await openSession(sealed, key())).toBeNull();
  });

  it("rejects an expired session", async () => {
    const k = key();
    const sealed = await sealSession({ accessToken: "t", expiresAt: now() - 10 }, k);
    expect(await openSession(sealed, k)).toBeNull();
  });

  it("rejects a tampered token", async () => {
    const k = key();
    const sealed = await sealSession({ accessToken: "t", expiresAt: now() + 300 }, k);
    const tampered = `${sealed.slice(0, -2)}${sealed.endsWith("AA") ? "BB" : "AA"}`;
    expect(await openSession(tampered, k)).toBeNull();
  });

  it("does not accept a login-flow cookie as a session", async () => {
    const k = key();
    const flow = await seal(
      "flow",
      { state: "s", nonce: "n", codeVerifier: "v", returnTo: "/" },
      k,
      now() + 300,
    );
    expect(await unseal("session", flow, k)).toBeNull();
    expect(await openSession(flow, k)).toBeNull();
  });

  it("treats a missing or malformed cookie as no session", async () => {
    expect(await openSession(undefined, key())).toBeNull();
    expect(await openSession("not-a-jwe", key())).toBeNull();
  });
});

describe("SESSION_SECRET", () => {
  it("accepts base64url of exactly 32 bytes", () => {
    expect(parseSecret(randomBytes(32).toString("base64url"))).toHaveLength(32);
  });

  it.each([16, 31, 33, 64])("rejects %i bytes", (size) => {
    expect(() => parseSecret(randomBytes(size).toString("base64url"))).toThrow();
  });
});
