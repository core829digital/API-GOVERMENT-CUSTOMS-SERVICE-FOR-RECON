import type { z } from "zod";
import { ApiError, kindForResponse } from "./errors";

/** The browser only ever talks to the same-origin BFF; it never sees the API origin or a token. */
export const BFF_PREFIX = "/api/bff";

export async function apiGet<S extends z.ZodType>(
  path: string,
  schema: S,
  init: { signal?: AbortSignal } = {},
): Promise<z.output<S>> {
  let response: Response;
  try {
    response = await fetch(`${BFF_PREFIX}${path}`, {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      signal: init.signal,
    });
  } catch (cause) {
    if (init.signal?.aborted) throw cause;
    throw new ApiError("network", null);
  }

  if (!response.ok) {
    throw new ApiError(
      kindForResponse(response.status, response.headers.has("retry-after")),
      response.status,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError("invalid_response", response.status);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError("invalid_response", response.status);
  }
  return parsed.data;
}
