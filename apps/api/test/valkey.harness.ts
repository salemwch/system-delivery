import process from "node:process";

import { Redis } from "ioredis";

/**
 * Integration-test Valkey harness.
 *
 * The outbox relay publishes to a real Valkey Stream, so its tests run against a
 * real Valkey — a mock cannot prove that `XADD`, `MAXLEN`, and stream ordering
 * behave as the relay relies on.
 *
 * Either point TEST_VALKEY_URL / VALKEY_URL at a running instance (local dev, CI
 * service container), or a disposable container is started via Testcontainers.
 */

export interface TestValkey {
  readonly client: Redis;
  readonly url: string;
  close(): Promise<void>;
}

export async function createTestValkey(): Promise<TestValkey> {
  const provided = process.env["TEST_VALKEY_URL"] ?? process.env["VALKEY_URL"];

  if (provided !== undefined && provided.length > 0) {
    const client = new Redis(provided, { maxRetriesPerRequest: 3 });
    return {
      client,
      url: provided,
      close: async () => {
        await client.quit();
      },
    };
  }

  const { GenericContainer, Wait } = await import("testcontainers");

  const container = await new GenericContainer(
    "valkey/valkey:8.1-alpine@sha256:6c54dd3a90f7b0b50ef19a89cb99cbbf7f6e59b9d8909f1bc225b60ca519efc3",
  )
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .withStartupTimeout(60_000)
    .start();

  const url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
  const client = new Redis(url, { maxRetriesPerRequest: 3 });

  return {
    client,
    url,
    close: async () => {
      await client.quit();
      await container.stop();
    },
  };
}
