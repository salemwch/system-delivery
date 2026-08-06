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

  /**
   * ⚠️ Content-Security-Policy is NOT here — `src/proxy.ts` builds it per
   * request, because it carries a nonce and a nonce must be unique per
   * response. As a static `script-src 'self'` it blocked every inline script
   * Next uses to start React. See `src/lib/csp.ts`.
   */
  // Next's type wants a promise; there is nothing to await, so it is returned
  // rather than declared `async` (which lint correctly flags as pointless).
  headers() {
    return Promise.resolve([
      {
        source: "/:path*",
        headers: [
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
