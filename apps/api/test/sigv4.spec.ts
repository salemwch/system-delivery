import { describe, expect, it } from "vitest";

import { presignUrl } from "../src/shared/storage/sigv4.js";

/**
 * SigV4 query-string signing against AWS's published example
 * (https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html):
 * GET examplebucket/test.txt, us-east-1, 2013-05-24T00:00:00Z, 86400 s.
 * If this signature ever changes, the signer is wrong, not the vector.
 */
describe("presignUrl (SigV4)", () => {
  const example = {
    method: "GET" as const,
    endpoint: "https://s3.amazonaws.com",
    bucket: "examplebucket",
    key: "test.txt",
    region: "us-east-1",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    forcePathStyle: false,
    expiresInSeconds: 86_400,
    now: new Date("2013-05-24T00:00:00Z"),
  };

  it("reproduces the AWS documentation example exactly", () => {
    const url = new URL(presignUrl(example));
    expect(url.host).toBe("examplebucket.s3.amazonaws.com");
    expect(url.pathname).toBe("/test.txt");
    expect(url.searchParams.get("X-Amz-Credential")).toBe(
      "AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request",
    );
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(url.searchParams.get("X-Amz-Signature")).toBe(
      "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });

  it("puts the bucket in the path for path-style stores, and signs extra headers", () => {
    const url = new URL(
      presignUrl({
        ...example,
        method: "PUT",
        endpoint: "http://localhost:9000",
        forcePathStyle: true,
        key: "tenant/t1/pod/s1/a b(1).jpg",
        headers: { "content-length": "1024", "content-type": "image/jpeg" },
      }),
    );
    expect(url.host).toBe("localhost:9000");
    // Every segment encoded per RFC 3986, including the characters
    // encodeURIComponent leaves alone; separators kept.
    expect(url.pathname).toBe("/examplebucket/tenant/t1/pod/s1/a%20b%281%29.jpg");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
  });

  it("changes the signature when any signed header changes", () => {
    const signatureFor = (length: string) =>
      new URL(
        presignUrl({ ...example, method: "PUT", headers: { "content-length": length } }),
      ).searchParams.get("X-Amz-Signature");
    expect(signatureFor("1024")).not.toBe(signatureFor("1025"));
  });

  it("refuses an expiry outside SigV4's bounds and a non-canonical header name", () => {
    expect(() => presignUrl({ ...example, expiresInSeconds: 0 })).toThrow(RangeError);
    expect(() => presignUrl({ ...example, expiresInSeconds: 604_801 })).toThrow(RangeError);
    expect(() => presignUrl({ ...example, headers: { "Content-Type": "image/png" } })).toThrow(
      /lower-case/u,
    );
  });
});
