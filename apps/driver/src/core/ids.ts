/**
 * UUIDv7 (RFC 9562 §5.7): 48-bit Unix milliseconds, then random bits.
 *
 * The platform's id rule (CLAUDE.md: "IDs: UUIDv7"): every idempotency key and
 * telemetry batch id the app mints is time-ordered, so the server's indexes on
 * them stay append-mostly. Randomness is injected (expo-crypto on the device,
 * node:crypto in tests) so this stays free of any native import.
 */
export type RandomBytes = (length: number) => Uint8Array;

export function uuidV7(random: RandomBytes, nowMs: number = Date.now()): string {
  const bytes = random(16);
  if (bytes.length !== 16) {
    throw new Error("uuidV7 needs 16 random bytes");
  }
  // 48-bit big-endian timestamp in bytes 0..5.
  let ms = Math.floor(nowMs);
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = ms & 0xff;
    ms = Math.floor(ms / 256);
  }
  // Version 7 in the high nibble of byte 6; RFC 4122 variant (10xx) in byte 8.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
