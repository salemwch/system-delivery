import type { NextConfig } from "next";

/**
 * The public tracking page (docs/08-frontend-architecture.md §7).
 *
 * ⚠️ This is the most exposed surface in the system: unauthenticated,
 * internet-facing, and reachable by anyone holding a link
 * (docs/07-security-architecture.md §2.2). It is deployed SEPARATELY from the
 * dispatcher app on purpose — separate CSP, separate rate limits, and a bug in
 * the dispatcher bundle cannot reach it.
 */
const config: NextConfig = {
  reactStrictMode: true,
  // The version is a free disclosure to anyone fingerprinting the deployment.
  poweredByHeader: false,

  // Next's type wants a promise; there is nothing to await, so it is returned
  // rather than declared `async` (which lint correctly flags as pointless).
  headers() {
    return Promise.resolve([
      {
        source: "/:path*",
        headers: [
          {
            // A tracking page renders no third-party anything: no analytics, no
            // fonts, no maps, no images from elsewhere. `default-src 'none'` with
            // a narrow allow-list is achievable here in a way it never is on an
            // app with embedded widgets, so it is worth taking.
            //
            // `style-src 'unsafe-inline'` is required by Next's inlined critical
            // CSS. Scripts get no such exemption.
            key: "Content-Security-Policy",
            value: [
              "default-src 'none'",
              "script-src 'self'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data:",
              "connect-src 'self'",
              "base-uri 'none'",
              "form-action 'none'",
              "frame-ancestors 'none'",
            ].join("; "),
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          {
            // A tracking URL carries a token in its query string. Sending it to
            // an analytics or ad network as a referrer would hand over the link
            // itself, so every capability that could leak it is denied.
            key: "Permissions-Policy",
            value: "geolocation=(), camera=(), microphone=(), interest-cohort=()",
          },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        ],
      },
    ]);
  },
};

export default config;
