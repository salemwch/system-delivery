/**
 * Field-level encryption for PII at rest.
 *
 * The `CryptoModule` is NOT re-exported here on purpose (see config/index.js): it
 * imports AppConfigModule, whose evaluation runs eager env validation, and a
 * barrel that drags that in throws under test. Composition roots import
 * `CryptoModule` from ./crypto.module.js directly.
 */
export { FieldCipher } from "./field-cipher.js";
export { FIELD_CIPHER } from "./crypto.tokens.js";
