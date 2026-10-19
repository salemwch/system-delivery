import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CircuitBreaker } from "../src/shared/http/circuit-breaker.js";
import { ObjectTooLargeError, S3ObjectStorage } from "../src/shared/storage/index.js";
import { createTestStorage } from "./storage.harness.js";
import type { TestStorage } from "./storage.harness.js";

/**
 * S3ObjectStorage against a real MinIO: what the signature allows, what it
 * refuses, and that reads are capped without buffering an oversize object.
 */
describe("S3ObjectStorage", () => {
  let store: TestStorage | undefined;
  let storage: S3ObjectStorage;

  beforeAll(async () => {
    const created = await createTestStorage();
    store = created;
    storage = new S3ObjectStorage(created.settings);
  }, 180_000);

  afterAll(async () => {
    // Undefined when setup itself failed; that failure is the one to report.
    await store?.close();
  });

  function settings() {
    if (store === undefined) throw new Error("storage not started");
    return store.settings;
  }

  const key = () => `test/${randomUUID()}/photo.jpg`;

  async function put(
    url: string,
    headers: Readonly<Record<string, string>>,
    body: Uint8Array,
  ): Promise<number> {
    // `content-length` comes from the body, as on a phone, never from the
    // signed headers: with Testcontainers loaded, `fetch` runs on its newer
    // undici, which refuses an explicit length beside a Buffer body. A body of
    // the wrong size therefore still arrives with its true length and is
    // refused by the store's signature check, which is what is under test.
    const { "content-length": _length, ...sent } = headers;
    const response = await fetch(url, { method: "PUT", headers: sent, body });
    await response.body?.cancel();
    return response.status;
  }

  it("accepts an upload of exactly the signed type and length, and reads it back", async () => {
    const objectKey = key();
    const bytes = randomBytes(2048);
    const upload = storage.presignPut(objectKey, {
      contentType: "image/jpeg",
      contentLength: bytes.byteLength,
    });

    expect(await put(upload.url, upload.headers, bytes)).toBe(200);
    expect(await storage.head(objectKey)).toEqual({
      sizeBytes: 2048,
      contentType: "image/jpeg",
    });
    expect(Buffer.from((await storage.read(objectKey, 4096)) ?? [])).toEqual(bytes);
  });

  it("refuses an upload whose length or type differs from what was signed", async () => {
    const objectKey = key();
    const upload = storage.presignPut(objectKey, {
      contentType: "image/jpeg",
      contentLength: 1024,
    });

    // A bigger file than agreed: its real content-length is not the signed one.
    expect(await put(upload.url, upload.headers, randomBytes(4096))).toBe(403);
    // Another type: e.g. text/html, to be served back as a page.
    expect(
      await put(upload.url, { ...upload.headers, "content-type": "text/html" }, randomBytes(1024)),
    ).toBe(403);
    expect(await storage.head(objectKey)).toBeNull();
  });

  it("refuses a URL signed with another secret", async () => {
    const forged = new S3ObjectStorage({ ...settings(), secretAccessKey: "not-the-secret" });
    const upload = forged.presignPut(key(), { contentType: "image/png", contentLength: 16 });
    expect(await put(upload.url, upload.headers, randomBytes(16))).toBe(403);
  });

  it("answers null for a missing object and refuses to buffer past the cap", async () => {
    expect(await storage.head(key())).toBeNull();
    expect(await storage.read(key(), 1024)).toBeNull();

    const objectKey = key();
    const bytes = randomBytes(5000);
    const upload = storage.presignPut(objectKey, {
      contentType: "image/png",
      contentLength: bytes.byteLength,
    });
    expect(await put(upload.url, upload.headers, bytes)).toBe(200);
    await expect(storage.read(objectKey, 4999)).rejects.toBeInstanceOf(ObjectTooLargeError);
  });

  it("fails fast once the store is unreachable", async () => {
    // Nothing listens on port 9 (discard), so every call fails.
    const dead = new S3ObjectStorage({ ...settings(), endpoint: "http://127.0.0.1:9" });
    for (let i = 0; i < 3; i += 1) {
      await expect(dead.head(key())).rejects.toThrow();
    }
    await expect(dead.head(key())).rejects.toThrow(/circuit breaker is open/u);
  });
});

describe("CircuitBreaker", () => {
  it("opens after the threshold, half-opens after the cooldown, closes on success", () => {
    let now = 0;
    const breaker = new CircuitBreaker(2, 1000, () => now);
    expect(breaker.recordFailure()).toBe(false);
    expect(breaker.isOpen).toBe(false);
    expect(breaker.recordFailure()).toBe(true);
    expect(breaker.isOpen).toBe(true);
    now = 1000;
    expect(breaker.isOpen).toBe(false); // half-open: one probe
    expect(breaker.recordFailure()).toBe(true); // probe failed: open again
    now = 2000;
    expect(breaker.isOpen).toBe(false);
    breaker.recordSuccess();
    expect(breaker.recordFailure()).toBe(false); // count restarted
    expect(() => new CircuitBreaker(0, 1000)).toThrow(RangeError);
  });
});
