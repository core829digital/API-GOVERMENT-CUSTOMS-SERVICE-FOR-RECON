/**
 * What the BFF may forward to the API: an explicit allowlist of routes, query parameters and headers. Anything
 * not listed here is refused or dropped, so a request path or header chosen by a browser cannot steer the
 * upstream request (SSRF, path traversal, header smuggling).
 */

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

type Segment = string | typeof UUID;

type Route = {
  /** Literal segments, or the UUID pattern for `{id}`. */
  readonly segments: readonly Segment[];
  /** Query parameters the route accepts, each at most once. */
  readonly query: readonly string[];
};

/** The v1 read routes the console uses. The BFF is GET-only (`route.ts` exports no other method). */
const ROUTES: readonly Route[] = [
  { segments: ["v1", "batches", UUID], query: [] },
  { segments: ["v1", "recon", "runs", UUID], query: [] },
  { segments: ["v1", "findings"], query: ["limit", "after", "check_code", "run_id"] },
];

const MAX_QUERY_VALUE = 128;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function matches(route: Route, segments: readonly string[]): boolean {
  return (
    route.segments.length === segments.length &&
    route.segments.every((expected, i) =>
      typeof expected === "string" ? segments[i] === expected : expected.test(segments[i] ?? ""),
    )
  );
}

/**
 * The upstream path and query (`/v1/findings?limit=5`) for a BFF request, or `null` when the path or query is not
 * allowed.
 *
 * `segments` are the already percent-decoded path segments Next.js hands to the route. They must equal a listed
 * route literal-for-literal (an id segment must be a canonical UUID), so `..`, `.`, empty segments, encoded
 * slashes or backslashes, and double-encoded sequences can never match. The query string is rebuilt from the
 * allowed parameters only; unknown or repeated parameters reject the request.
 */
export function upstreamPath(segments: readonly string[], search: string): string | null {
  const route = ROUTES.find((r) => matches(r, segments));
  if (!route) return null;

  const incoming = new URLSearchParams(search);
  const keys = [...incoming.keys()];
  if (new Set(keys).size !== keys.length) return null;
  if (keys.some((key) => !route.query.includes(key))) return null;
  const query = new URLSearchParams();
  for (const key of route.query) {
    const value = incoming.get(key);
    if (value === null) continue;
    if (value.length === 0 || value.length > MAX_QUERY_VALUE || CONTROL.test(value)) return null;
    query.set(key, value);
  }

  const path = `/${segments.map(encodeURIComponent).join("/")}`;
  const qs = query.toString();
  return qs ? `${path}?${qs}` : path;
}

/** `upstreamPath` joined onto the API base URL (a path prefix on the base is kept). */
export function upstreamUrl(base: string, segments: readonly string[], search: string): URL | null {
  const path = upstreamPath(segments, search);
  return path === null ? null : new URL(`${base.replace(/\/+$/, "")}${path}`);
}

/** The only inbound request headers that are passed on; everything else (cookies, host, forwarding headers…) is dropped. */
const FORWARDED_REQUEST_HEADERS = ["x-min-seq"] as const;
const MIN_SEQ = /^[0-9]{1,19}$/;

/** Headers for the upstream request: a fixed set, plus allowlisted inbound headers with a valid value. */
export function upstreamHeaders(inbound: Headers, accessToken: string): Headers {
  const headers = new Headers({ authorization: `Bearer ${accessToken}`, accept: "application/json" });
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = inbound.get(name);
    if (value !== null && MIN_SEQ.test(value)) headers.set(name, value);
  }
  return headers;
}

/** Upstream response headers that reach the browser. */
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "retry-after",
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset",
] as const;

export function downstreamHeaders(upstream: Headers): Headers {
  const headers = new Headers({ "cache-control": "no-store" });
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}
