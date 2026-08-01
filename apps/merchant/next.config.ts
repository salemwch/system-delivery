import type { NextConfig } from "next";

/**
 * The merchant portal.
 *
 * A SEPARATE deployable from the staff dispatcher app, deliberately: merchants
 * are external customers, not staff. Separate deploy means a bug in the
 * dispatcher bundle cannot reach a merchant, and it mirrors the boundary the
 * database already enforces — `MERCHANT` is the only role scoped BELOW the
 * tenant, narrowed by RLS on `users.merchant_id` (invariant I24).
 */
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  headers() {
    return Promise.resolve([
      {
        source: "/:path*",
        headers: [
          {
            // No third-party anything: no analytics, no CDN fonts, no maps. The
            // portal talks to its own server and nothing else, so a tight policy
            // is achievable here in a way it is not on an app with widgets.
            //
            // `'unsafe-inline'` for styles only — Next inlines critical CSS.
            // Scripts get no such exemption.
            key: "Content-Security-Policy",
            value: [
              "default-src 'none'",
              "script-src 'self'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data:",
              "connect-src 'self'",
              "form-action 'self'",
              "base-uri 'none'",
              "frame-ancestors 'none'",
            ].join("; "),
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        ],
      },
    ]);
  },
};

export default config;
