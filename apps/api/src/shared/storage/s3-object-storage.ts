import { CircuitBreaker } from "../http/circuit-breaker.js";
import type { ObjectStorage, PresignedUpload, StoredObject } from "./object-storage.js";
import { presignUrl } from "./sigv4.js";

export interface S3Settings {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
}

/** An upload URL outlives a slow 3G upload of a 10 MB photo, and little more. */
const UPLOAD_URL_TTL_SECONDS = 15 * 60;
/** Server-side reads use a URL spent within the request. */
const READ_URL_TTL_SECONDS = 60;
/** Long enough to open a photo from the review screen, short enough not to share. */
const VIEW_URL_TTL_SECONDS = 5 * 60;
/** A 10 MB read from a healthy store is well under this; a hung one is cut off. */
const REQUEST_TIMEOUT_MS = 15_000;
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 30_000;

/**
 * S3-compatible object storage over native `fetch` (MinIO, DigitalOcean
 * Spaces, AWS S3). Server-side reads are presigned too, so there is exactly one
 * signing path to get right (sigv4.ts) and no credential in any header.
 *
 * Every call has a timeout and goes through a circuit breaker: a dead store
 * makes POD verification fail fast and retryable, instead of holding a request
 * and a socket per driver for the length of the outage.
 */
export class S3ObjectStorage implements ObjectStorage {
  private readonly breaker = new CircuitBreaker(BREAKER_THRESHOLD, BREAKER_COOLDOWN_MS);

  constructor(
    private readonly settings: S3Settings,
    private readonly now: () => Date = () => new Date(),
  ) {}

  presignPut(
    key: string,
    upload: { readonly contentType: string; readonly contentLength: number },
  ): PresignedUpload {
    const headers = {
      "content-length": String(upload.contentLength),
      "content-type": upload.contentType,
    };
    return {
      url: this.sign("PUT", key, UPLOAD_URL_TTL_SECONDS, headers),
      headers,
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    };
  }

  presignGet(key: string): { readonly url: string; readonly expiresInSeconds: number } {
    return {
      url: this.sign("GET", key, VIEW_URL_TTL_SECONDS),
      expiresInSeconds: VIEW_URL_TTL_SECONDS,
    };
  }

  async head(key: string): Promise<StoredObject | null> {
    const response = await this.call("HEAD", key);
    if (response === null) {
      return null;
    }
    const length = Number(response.headers.get("content-length"));
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new Error("Object storage returned no usable content-length");
    }
    return { sizeBytes: length, contentType: response.headers.get("content-type") };
  }

  async read(key: string, maxBytes: number): Promise<Uint8Array | null> {
    const response = await this.call("GET", key);
    if (response === null) {
      return null;
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel();
      throw new ObjectTooLargeError(maxBytes);
    }
    // Streamed with a running count: a store that omits or misstates the
    // length still cannot make this buffer more than the cap.
    const reader = response.body?.getReader();
    if (reader === undefined) {
      return new Uint8Array(0);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      // Node types the body stream loosely; a chunk is narrowed, never trusted.
      const result: { readonly done: boolean; readonly value?: unknown } = await reader.read();
      if (result.done) {
        break;
      }
      const value = result.value;
      if (!(value instanceof Uint8Array)) {
        await reader.cancel();
        throw new Error("Object storage returned a non-binary chunk");
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ObjectTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  /** A signed request: null on 404, the response on 2xx, an error otherwise. */
  private async call(method: "GET" | "HEAD", key: string): Promise<Response | null> {
    if (this.breaker.isOpen) {
      throw new Error("Object storage circuit breaker is open");
    }
    let response: Response;
    try {
      response = await fetch(this.sign(method, key, READ_URL_TTL_SECONDS), {
        method,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      this.breaker.recordFailure();
      throw error;
    }
    if (response.status === 404) {
      // The store answered: healthy, the object is simply absent.
      this.breaker.recordSuccess();
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      // 5xx is the store failing; 4xx (a 403 from a bad credential) is ours,
      // but it fails every call the same way, so it counts too.
      this.breaker.recordFailure();
      await response.body?.cancel();
      throw new Error(`Object storage answered ${String(response.status)} to ${method}`);
    }
    this.breaker.recordSuccess();
    return response;
  }

  private sign(
    method: "GET" | "PUT" | "HEAD",
    key: string,
    expiresInSeconds: number,
    headers?: Readonly<Record<string, string>>,
  ): string {
    return presignUrl({
      method,
      endpoint: this.settings.endpoint,
      bucket: this.settings.bucket,
      key,
      region: this.settings.region,
      accessKeyId: this.settings.accessKeyId,
      secretAccessKey: this.settings.secretAccessKey,
      forcePathStyle: this.settings.forcePathStyle,
      expiresInSeconds,
      now: this.now(),
      ...(headers === undefined ? {} : { headers }),
    });
  }
}

/** The object exceeds the caller's cap; it was not buffered. */
export class ObjectTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Object exceeds ${String(maxBytes)} bytes`);
    this.name = "ObjectTooLargeError";
  }
}
