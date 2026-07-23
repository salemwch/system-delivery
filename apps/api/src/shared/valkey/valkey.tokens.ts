/**
 * DI token for the shared Valkey (Redis-protocol) client.
 *
 * A symbol, not a string, so it cannot collide with another provider token and
 * cannot be forged from user input.
 */
export const VALKEY_CLIENT = Symbol("VALKEY_CLIENT");
