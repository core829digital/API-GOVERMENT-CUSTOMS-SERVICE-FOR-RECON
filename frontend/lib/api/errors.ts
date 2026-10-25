export type ApiErrorKind =
  | "unauthenticated"
  | "not_found"
  | "replica_lag"
  | "unavailable"
  | "invalid_response"
  | "network";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;

  constructor(kind: ApiErrorKind, status: number | null) {
    super(kind);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
  }
}

/**
 * Maps a non-2xx response to an error kind. Architecture.md §5.2: a read that cannot be
 * served within `bridge.wait_ms` is `503 replica_lag` with a `Retry-After` header; the
 * header is what distinguishes it here, the body is not parsed.
 */
export function kindForResponse(status: number, hasRetryAfter: boolean): ApiErrorKind {
  if (status === 401) return "unauthenticated";
  if (status === 404) return "not_found";
  if (status === 503 && hasRetryAfter) return "replica_lag";
  return "unavailable";
}
