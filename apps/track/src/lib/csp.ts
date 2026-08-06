import { isProduction } from "./config";

/**
 * The Content-Security-Policy, built per request around a fresh nonce.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT A STATIC HEADER IN next.config.ts
 *
 * It was, as `script-src 'self'`, and that broke the application outright.
 * Next bootstraps React with INLINE `<script>` tags — the RSC payload, the
 * hydration entry, the route manifest — and `'self'` does not permit inline
 * code. Every one of them was blocked, React never hydrated, and the console
 * filled with "Executing inline script violates the following Content Security
 * Policy directive".
 *
 * The visible symptom was not an error page. It was a form whose button did
 * nothing: server-rendered HTML looked perfect, and the client runtime that
 * makes a Server Action submit never started.
 *
 * A nonce is the fix, and a nonce cannot live in a static header — it must be
 * unique per response or it is worth nothing. Next reads it back out of this
 * header and stamps it on the scripts it generates.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** 16 bytes of CSPRNG, base64. Web Crypto — the proxy runs on the Edge runtime. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export function contentSecurityPolicy(nonce: string): string {
  const dev = !isProduction();

  const directives = [
    "default-src 'none'",

    /*
     * `'strict-dynamic'` lets a nonced script load the chunks it needs without
     * naming each one, which is what Next's loader does. Browsers that honour
     * it IGNORE `'self'` and the host list, so those remain only for older
     * engines.
     *
     * `'unsafe-eval'` is DEVELOPMENT ONLY: Turbopack's HMR runtime evaluates
     * modules as they arrive. Production ships compiled chunks and must never
     * carry it.
     */
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,

    // Tailwind emits a style element, and React inlines critical CSS. There is
    // no nonce path for those, and `'unsafe-inline'` on styles cannot execute
    // code — the risk is defacement, not script execution.
    `style-src 'self' 'unsafe-inline'${dev ? " https://fonts.googleapis.com" : ""}`,

    // `data:` for inline SVG status icons. No blob: — this page generates
    // nothing client-side.
    "img-src 'self' data:",

    // Self-hosted only in production. In development the Next error overlay
    // pulls its own webfonts from Google, and blocking them buries real errors
    // under CSP noise.
    `font-src 'self' data:${dev ? " https://fonts.gstatic.com" : ""}`,

    // `ws:` for Turbopack HMR, which is a different scheme from `'self'` and is
    // therefore not covered by it.
    `connect-src 'self'${dev ? " ws: http://localhost:*" : ""}`,

    // No workers and no forms: the tracking page submits nothing. Locking both
    // to 'none' costs nothing here and would matter if a widget ever crept in.
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ];

  // Never in development: it would upgrade http://localhost to https and the
  // dev server speaks plain HTTP.
  return (dev ? directives.slice(0, -1) : directives).join("; ");
}
