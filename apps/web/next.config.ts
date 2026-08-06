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

  /**
   * ⚠️ Content-Security-Policy is NOT here — it is built per request in
   * `src/proxy.ts`, because it carries a nonce and a nonce must be unique per
   * response.
   *
   * It lived here as `script-src 'self'`, which blocked every inline script
   * Next uses to hydrate React. The page rendered and then did nothing: forms
   * submitted nowhere, buttons had no handlers. See `src/lib/csp.ts`.
   *
   * The headers below are constant and belong here.
   */
  headers() {
    return Promise.resolve([
      {
        source: "/:path*",
        headers: [
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
