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
