/**
 * Object storage for POD media.
 *
 * `StorageModule` is NOT re-exported here (see crypto/index.ts): it imports
 * AppConfigModule, whose evaluation validates the environment eagerly.
 * Composition roots import it from ./storage.module.js directly.
 */
export { OBJECT_STORAGE } from "./object-storage.js";
export type { ObjectStorage, PresignedUpload, StoredObject } from "./object-storage.js";
export { ObjectTooLargeError, S3ObjectStorage } from "./s3-object-storage.js";
export type { S3Settings } from "./s3-object-storage.js";
export { MALWARE_SCANNER, PassThroughMalwareScanner } from "./malware-scanner.js";
export type { MalwareScanner, ScanResult } from "./malware-scanner.js";
