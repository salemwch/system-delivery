/**
 * DI token for the configured field cipher.
 *
 * A symbol token (not the class) so the provider can build a `FieldCipher` from
 * the runtime key via a factory, while consumers inject the same instance without
 * knowing how the key is sourced.
 */
export const FIELD_CIPHER = Symbol("FIELD_CIPHER");
