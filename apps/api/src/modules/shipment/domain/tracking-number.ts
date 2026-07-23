import { randomBytes } from "node:crypto";

/**
 * Tracking-number generation (docs/02-domain-model.md §3.6 rule 10).
 *
 * Human-facing, generated, NON-sequential, and unique per tenant. Non-sequential
 * matters: a sequential reference leaks shipment volume to competitors and lets
 * anyone enumerate a rival tracking page. We draw from a cryptographic source
 * (never Math.random — SAST no-math-random-for-security-values) and encode with
 * Crockford base32, which omits the ambiguous I/L/O/U so a recipient reading the
 * code off an SMS to a call-centre agent does not mis-key it.
 *
 * Uniqueness is guaranteed by the `shipments_tenant_tracking_uq` constraint, not
 * by hoping a random draw never collides; the caller retries on the rare clash.
 */

// Crockford base32 alphabet — no I, L, O, U.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const BODY_LENGTH = 10;

export function generateTrackingNumber(): string {
  // 10 base32 symbols = 50 bits of entropy. Drawing a byte per symbol and masking
  // to 5 bits keeps the distribution uniform (no modulo bias across 32 values).
  const bytes = randomBytes(BODY_LENGTH);
  let body = "";
  for (let i = 0; i < BODY_LENGTH; i += 1) {
    // Non-null: i < BODY_LENGTH and bytes has exactly BODY_LENGTH elements, but
    // noUncheckedIndexedAccess still types this as possibly-undefined.
    const byte = bytes[i] ?? 0;
    body += ALPHABET[byte & 0x1f];
  }
  // Grouped for legibility when read aloud: e.g. "SD-3F7K-9QW2XM".
  return `SD-${body.slice(0, 4)}-${body.slice(4)}`;
}
