/**
 * Narrows a caller-supplied return path to somewhere on this origin.
 *
 * The `next` parameter on the refresh route arrives in the query string, so it
 * is attacker-controlled. Without this the route is an open redirect — and one
 * that only fires for signed-in staff, which is exactly who a phishing link
 * would target: the victim lands on a real, authenticated URL of the courier's
 * own console and is then bounced to a look-alike login.
 *
 * Pure and exported so the rules can be tested directly. Everything that is not
 * provably a same-origin path falls back.
 */
export function safeReturnPath(candidate: string | null, fallback: string): string {
  if (candidate === null || candidate === "") {
    return fallback;
  }
  // Must be a rooted path on this origin. `//evil.com` is protocol-relative and
  // `https://evil.com` absolute — a browser resolves both off-site. `/\evil.com`
  // is read as `//evil.com` by some parsers, so it goes too.
  if (!candidate.startsWith("/") || candidate.startsWith("//") || candidate.startsWith("/\\")) {
    return fallback;
  }
  if (hasControlCharacter(candidate)) {
    return fallback;
  }
  return candidate;
}

/**
 * C0 controls (below 0x20) and DEL (0x7F).
 *
 * Written as a code-point scan rather than a regex on purpose: the escape
 * sequences for this range are easy to mangle into literal control characters
 * in the source itself, which then looks like an empty character class and
 * matches nothing. A comparison cannot be corrupted invisibly.
 *
 * These can split a header or truncate a URL in a parser that disagrees with
 * ours. Rejected rather than stripped — a path containing one was never
 * legitimate.
 */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}
