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

/**
 * The per-request CSP nonce, and the policy carrying it.
 *
 * Next reads `Content-Security-Policy` off the REQUEST to find the nonce and
 * stamp it on the inline scripts it emits. It must be set on the request as
 * well as the response, or the browser blocks scripts the policy allows.
 */
export const NONCE_HEADER = "x-nonce";
export const CSP_HEADER = "Content-Security-Policy";
