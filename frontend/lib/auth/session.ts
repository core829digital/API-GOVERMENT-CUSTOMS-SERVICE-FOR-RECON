import { SESSION_COOKIE } from "./cookies";
import { seal, unseal, type SessionPayload } from "./seal";

export async function sealSession(payload: SessionPayload, key: Uint8Array): Promise<string> {
  return seal("session", payload, key, payload.expiresAt);
}

export async function openSession(
  token: string | undefined,
  key: Uint8Array,
): Promise<SessionPayload | null> {
  if (!token) return null;
  const payload = await unseal("session", token, key);
  if (
    !payload ||
    typeof payload.accessToken !== "string" ||
    typeof payload.expiresAt !== "number"
  ) {
    return null;
  }
  return { accessToken: payload.accessToken, expiresAt: payload.expiresAt };
}

export { SESSION_COOKIE };
