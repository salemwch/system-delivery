import { randomBytes } from "node:crypto";
import process from "node:process";

import type { S3Settings } from "../src/shared/storage/index.js";

/**
 * A real S3-compatible store for integration tests.
 *
 * Uses the configured store when `S3_*` is set (the local `pnpm dev:infra`
 * MinIO, via .env), and otherwise starts MinIO in a container, the same image
 * as compose pinned by digest, so CI exercises the real signing and size
 * checks rather than a mock of them.
 */
export interface TestStorage {
  readonly settings: S3Settings;
  close(): Promise<void>;
}

const MINIO_IMAGE =
  "minio/minio:RELEASE.2025-09-07T16-13-09Z@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e";

export async function createTestStorage(): Promise<TestStorage> {
  // An empty value counts as unset, so `S3_ENDPOINT= pnpm test` forces the
  // container path locally, exactly as CI runs it.
  const env = (name: string): string | undefined => {
    const value = process.env[name];
    return value === undefined || value === "" ? undefined : value;
  };
  const endpoint = env("S3_ENDPOINT");
  const region = env("S3_REGION");
  const bucket = env("S3_BUCKET");
  const accessKeyId = env("S3_ACCESS_KEY_ID");
  const secretAccessKey = env("S3_SECRET_ACCESS_KEY");
  if (
    endpoint !== undefined &&
    region !== undefined &&
    bucket !== undefined &&
    accessKeyId !== undefined &&
    secretAccessKey !== undefined
  ) {
    return {
      settings: {
        endpoint,
        region,
        bucket,
        accessKeyId,
        secretAccessKey,
        forcePathStyle: env("S3_FORCE_PATH_STYLE") !== "false",
      },
      close: () => Promise.resolve(),
    };
  }

  const { GenericContainer, Wait } = await import("testcontainers");
  // Generated per run: a fixed credential in a test file is what a secret
  // scanner is right to flag.
  const user = `test${randomBytes(4).toString("hex")}`;
  const password = randomBytes(18).toString("hex");
  const testBucket = "delivery-pod-test";
  const container = await new GenericContainer(MINIO_IMAGE)
    .withCommand(["server", "/data"])
    .withEnvironment({ MINIO_ROOT_USER: user, MINIO_ROOT_PASSWORD: password })
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp("/minio/health/ready", 9000))
    .withStartupTimeout(120_000)
    .start();

  // The image ships `mc`; the bucket is created private, as minio-init does.
  const created = await container.exec([
    "sh",
    "-c",
    `mc alias set local http://localhost:9000 ${user} ${password} >/dev/null && mc mb local/${testBucket} && mc anonymous set none local/${testBucket}`,
  ]);
  if (created.exitCode !== 0) {
    await container.stop();
    throw new Error(`MinIO bucket setup failed: ${created.output}`);
  }

  return {
    settings: {
      endpoint: `http://${container.getHost()}:${String(container.getMappedPort(9000))}`,
      region: "us-east-1",
      bucket: testBucket,
      accessKeyId: user,
      secretAccessKey: password,
      forcePathStyle: true,
    },
    close: async () => {
      await container.stop();
    },
  };
}
