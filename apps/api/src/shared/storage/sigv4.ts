import { createHash, createHmac } from "node:crypto";

/**
 * AWS Signature Version 4, query-string ("presigned URL") form, for S3 and
 * S3-compatible stores (MinIO locally, DigitalOcean Spaces in production).
 *
 * Hand-rolled on `node:crypto` instead of `@aws-sdk/s3-request-presigner`
 * (decision 2026-10-19): one pure function, no dependency tree to audit, the
 * same choice as the SMTP and FCM providers. It is pinned to the published
 * algorithm and tested against AWS's own example signature:
 * https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
 *
 * The payload is never signed (`UNSIGNED-PAYLOAD`): the uploader holds the
 * bytes, not the server. What IS signed is every header listed in `headers`,
 * which is how a presigned PUT pins the exact `content-length` and
 * `content-type` the server agreed to. A client sending anything else gets a
 * signature mismatch from the store.
 */
export interface PresignInput {
  readonly method: "GET" | "PUT" | "HEAD";
  /** Scheme + host (+ port), e.g. `https://fra1.digitaloceanspaces.com`. */
  readonly endpoint: string;
  readonly bucket: string;
  /** Object key, unencoded. */
  readonly key: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** `bucket` in the path (MinIO) instead of in the host name (Spaces, S3). */
  readonly forcePathStyle: boolean;
  /** 1 s to 7 days, the SigV4 bound. */
  readonly expiresInSeconds: number;
  readonly now: Date;
  /** Extra headers the request MUST carry, names lower-case. `host` is always signed. */
  readonly headers?: Readonly<Record<string, string>>;
}

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";
const MAX_EXPIRES_SECONDS = 7 * 24 * 60 * 60;

export function presignUrl(input: PresignInput): string {
  if (
    !Number.isInteger(input.expiresInSeconds) ||
    input.expiresInSeconds < 1 ||
    input.expiresInSeconds > MAX_EXPIRES_SECONDS
  ) {
    throw new RangeError("expiresInSeconds must be an integer between 1 and 604800");
  }
  const base = new URL(input.endpoint);
  const host = input.forcePathStyle ? base.host : `${input.bucket}.${base.host}`;
  const path = input.forcePathStyle
    ? `/${encodeSegment(input.bucket)}/${encodeKey(input.key)}`
    : `/${encodeKey(input.key)}`;

  const amzDate = toAmzDate(input.now);
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${input.region}/${SERVICE}/aws4_request`;

  const headers = new Map<string, string>([["host", host]]);
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    const lower = name.toLowerCase();
    if (lower !== name) {
      throw new Error(`Signed header names must be lower-case: ${name}`);
    }
    headers.set(lower, value.trim().replace(/\s+/gu, " "));
  }
  const names = [...headers.keys()].sort();
  const signedHeaders = names.join(";");
  const canonicalHeaders = names.map((name) => `${name}:${headers.get(name) ?? ""}\n`).join("");

  const query: [string, string][] = [
    ["X-Amz-Algorithm", ALGORITHM],
    ["X-Amz-Credential", `${input.accessKeyId}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(input.expiresInSeconds)],
    ["X-Amz-SignedHeaders", signedHeaders],
  ];
  const canonicalQuery = canonicalQueryString(query);

  const canonicalRequest = [
    input.method,
    path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = hmac(
    signingKey(input.secretAccessKey, day, input.region),
    stringToSign,
  ).toString("hex");

  return `${base.protocol}//${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** `20130524T000000Z` — basic ISO 8601, UTC, no fractional seconds. */
function toAmzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}/u, "");
}

function signingKey(secret: string, day: string, region: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, day);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, SERVICE);
  return hmac(kService, "aws4_request");
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function canonicalQueryString(pairs: readonly [string, string][]): string {
  return pairs
    .map(([key, value]) => [encodeSegment(key), encodeSegment(value)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

/** An object key keeps its `/` separators; every segment is encoded. */
function encodeKey(key: string): string {
  return key.split("/").map(encodeSegment).join("/");
}

/**
 * RFC 3986 encoding as SigV4 defines it: everything except the unreserved set
 * `A-Z a-z 0-9 - _ . ~`. `encodeURIComponent` leaves `! ' ( ) *` alone, and a
 * key containing one of them would otherwise sign differently from how the
 * store reads it.
 */
function encodeSegment(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
