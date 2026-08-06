/**
 * The session cookie's name, and nothing else.
 *
 * Its own module because `proxy.ts` needs it and `session.ts` imports
 * `node:crypto` at the top level — pulling that into the proxy drags the whole
 * AES-GCM seal into a runtime that has no business decrypting anything. The
 * proxy only asks "is there a cookie at all"; the server decides whether it is
 * valid.
 */
export const SESSION_COOKIE_NAME = "merchant_session";
