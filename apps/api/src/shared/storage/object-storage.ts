/**
 * The object-storage port: what the application needs from S3, nothing more.
 *
 * Binaries never pass through the API (docs/07 §7.1): the client uploads
 * straight to storage with a presigned URL, and the server only reads back
 * what it must verify. Implementation: `S3ObjectStorage` (MinIO, Spaces, S3).
 */
export interface PresignedUpload {
  readonly url: string;
  /** Headers the upload MUST send verbatim; they are part of the signature. */
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresInSeconds: number;
}

export interface StoredObject {
  readonly sizeBytes: number;
  readonly contentType: string | null;
}

export interface ObjectStorage {
  /** A URL that accepts a PUT of exactly this type and length, for a limited time. */
  presignPut(
    key: string,
    upload: { readonly contentType: string; readonly contentLength: number },
  ): PresignedUpload;

  /**
   * A short-lived URL to view one object, served from the storage origin, never
   * the application's (docs/07 §7.1: a separate origin with no ambient
   * credentials).
   */
  presignGet(key: string): { readonly url: string; readonly expiresInSeconds: number };

  /** Size and declared type, or null when there is no such object. */
  head(key: string): Promise<StoredObject | null>;

  /**
   * The whole object, or null when there is none. Refuses anything larger than
   * `maxBytes` without buffering it: a size cap that reads first and checks
   * after is no cap.
   */
  read(key: string, maxBytes: number): Promise<Uint8Array | null>;
}

/** DI token for the configured {@link ObjectStorage}. */
export const OBJECT_STORAGE = Symbol("OBJECT_STORAGE");
