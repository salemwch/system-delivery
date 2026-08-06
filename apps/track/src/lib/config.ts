/**
 * The single boundary between the environment and this app.
 *
 * Mirrors the API's `AppConfigService`: environment variables are read HERE and
 * nowhere else, validated once, and a missing required value fails loudly rather
 * than rendering a broken page. `process.env` is banned everywhere else in the
 * repo by lint, and this file is the one exemption — same arrangement as
 * `config.schema.ts` on the API side.
 *
 * ⚠️ Nothing here is `NEXT_PUBLIC_`. The API's address and the support number
 * are server-side only: this page is server-rendered end to end, so the browser
 * never needs them, and the tracking token never reaches client JavaScript.
 */

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    // Thrown at first use rather than at import: Next evaluates modules during
    // the build, where these are legitimately absent.
    throw new Error(`${name} is not set`);
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

/** Where the API lives. Server-side only — never exposed to the browser. */
export function apiBaseUrl(): string {
  return required("API_BASE_URL").replace(/\/+$/u, "");
}

/**
 * The courier's IANA zone, for rendering dates.
 *
 * ⚠️ Explicit, never the server's default. A UTC container would otherwise show
 * a Tunisian recipient times an hour out — which reads as the parcel being
 * collected after it was delivered.
 */
export function timezone(): string {
  return optional("TRACKING_TIMEZONE", "Africa/Tunis");
}

/** Support number for "Besoin d'aide ?". Empty hides the block rather than printing a blank. */
export function supportPhone(): string {
  return optional("TRACKING_SUPPORT_PHONE", "");
}

/** Gates the development-only relaxations in the Content-Security-Policy. */
export function isProduction(): boolean {
  return process.env["NODE_ENV"] === "production";
}
