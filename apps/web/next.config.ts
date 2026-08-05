import type { NextConfig } from "next";

/**
 * The staff dispatcher + admin console.
 *
 * Serves DISPATCHER, OWNER, HUB_OPERATOR, FINANCE, and PLATFORM_ADMIN roles
 * behind ONE deployment with role-based routing. Separate from the merchant
 * portal: merchants are external customers, and a bug in this app must never
 * touch a merchant's view.
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
            key: "Content-Security-Policy",
            value: [
              "default-src 'none'",
              "script-src 'self'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              "connect-src 'self'",
              "worker-src 'self' blob:",
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
