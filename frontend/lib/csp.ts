/**
 * Content-Security-Policy for the pages, built per request in `proxy.ts` with a fresh nonce (the mechanism
 * documented in node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md). Pages that carry a
 * nonce must be rendered dynamically; `app/layout.tsx` reads the nonce from the request, which does that.
 *
 * - Scripts: only the nonce (`'strict-dynamic'` then lets Next's own chunk loaders load the rest); no inline
 *   script and no `eval` in production. Development adds `'unsafe-eval'` because React needs it there.
 * - Styles: stylesheets and `<style>` elements need the nonce. `style-src-attr 'unsafe-inline'` is the one
 *   concession: server-rendered `style="…"` attributes (animation delays, sidebar width variables) cannot carry a
 *   nonce. It allows inline style attributes only, never `<style>` elements or scripts.
 * - Everything else is same-origin; no plugins (`object-src 'none'`), no `<base>` hijack, forms post only to us,
 *   nobody may frame the site, and in production plain-HTTP subresources are upgraded.
 */
export function buildCsp(nonce: string, options: { development: boolean }): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${options.development ? " 'unsafe-eval'" : ""}`,
    // React and Next set element styles through the CSSOM at runtime, which a nonce cannot cover; stylesheets
    // stay same-origin. Scripts remain nonce-locked, which is the XSS-relevant half.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (!options.development) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

/** 128 random bits, base64. A nonce must be unpredictable and never reused across requests. */
export function newNonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}
