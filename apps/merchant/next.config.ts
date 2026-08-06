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

  /**
   * ⚠️ Content-Security-Policy is NOT here — it is built per request in
   * `src/proxy.ts`, because it carries a nonce and a nonce must be unique per
   * response.
   *
   * It lived here as `script-src 'self'`, which blocked every inline script
   * Next uses to hydrate React: the page rendered and then did nothing, forms
   * included. See `src/lib/csp.ts`.
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
