/**
 * Builds the upstream API URL for a BFF request, or `null` when the path is not allowed.
 * Only the `/v1/...` API surface is reachable, and no segment may climb out of it.
 */
export function upstreamUrl(base: string, segments: string[], search: string): URL | null {
  if (segments[0] !== "v1") return null;
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === ".." || /[/\\]/.test(segment)) {
      return null;
    }
  }
  const url = new URL(`${base.replace(/\/+$/, "")}/${segments.map(encodeURIComponent).join("/")}`);
  url.search = search;
  return url;
}
