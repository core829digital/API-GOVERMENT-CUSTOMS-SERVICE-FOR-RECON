import * as client from "openid-client";
import type { AuthConfig } from "./config";

let cached: { key: string; promise: Promise<client.Configuration> } | undefined;

/** Discovery is cached per process; a failed discovery is not cached. */
export function getOidcConfiguration(config: AuthConfig): Promise<client.Configuration> {
  const key = `${config.issuer.href}|${config.clientId}`;
  if (cached?.key === key) return cached.promise;
  const promise = client.discovery(config.issuer, config.clientId, config.clientSecret);
  cached = { key, promise };
  promise.catch(() => {
    if (cached?.promise === promise) cached = undefined;
  });
  return promise;
}

export { client };
