import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

// Static security headers for every response. The per-request, nonce-based Content-Security-Policy for pages is
// set in proxy.ts; the JSON endpoints under /api get a "nothing may load" policy below.
const baseHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: [
      "accelerometer",
      "autoplay",
      "bluetooth",
      "browsing-topics",
      "camera",
      "display-capture",
      "encrypted-media",
      "geolocation",
      "gyroscope",
      "hid",
      "magnetometer",
      "microphone",
      "midi",
      "payment",
      "serial",
      "usb",
      "xr-spatial-tracking",
    ]
      .map((feature) => `${feature}=()`)
      .join(", "),
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  // Legacy twin of CSP frame-ancestors for browsers that only know this header.
  { key: "X-Frame-Options", value: "DENY" },
];

// Two years, all subdomains, preload-eligible. Production only: browsers ignore HSTS over plain HTTP, and a dev
// server must not teach anyone's browser to refuse http://localhost. Submitting to the preload list is a
// separate, deliberate step.
const hsts = { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" };

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: process.env.NODE_ENV === "production" ? [...baseHeaders, hsts] : baseHeaders },
      {
        source: "/api/:path*",
        headers: [{ key: "Content-Security-Policy", value: "default-src 'none'; frame-ancestors 'none'" }],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
