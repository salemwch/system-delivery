/**
 * The session cookie's name, and nothing else.
 *
 * Its own module because `middleware.ts` needs it and `session.ts` imports
 * `node:crypto` at the top level — pulling that into middleware drags the whole
 * AES-GCM seal into a runtime that has no business decrypting anything. The
 * middleware only asks "is there a cookie at all"; the server decides whether
 * it is valid.
 */
export const SESSION_COOKIE_NAME = "web_session";

/**
 * Request headers the proxy adds so a server render can learn its own URL.
 *
 * A Server Component has no access to the request path or the matched route
 * params of its caller, and `currentSession()` needs both to redirect an
 * expired session back to where the visitor actually was.
 */
export const LOCALE_HEADER = "x-web-locale";
export const PATHNAME_HEADER = "x-web-pathname";

/**
 * The per-request CSP nonce, and the policy carrying it.
 *
 * Next reads `Content-Security-Policy` off the REQUEST to find the nonce and
 * stamp it on the inline scripts it emits. Set it on the request as well as the
 * response, or the browser blocks scripts the policy was meant to allow.
 */
export const NONCE_HEADER = "x-nonce";
export const CSP_HEADER = "Content-Security-Policy";
