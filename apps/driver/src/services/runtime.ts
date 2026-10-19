import { getRandomBytes } from "expo-crypto";

import { ApiClient } from "../core/api";
import { uuidV7 } from "../core/ids";
import { appConfig } from "../platform/config";
import { deviceId, secureSessions } from "../platform/secure";

/**
 * Per-runtime singletons. The UI and Android's headless task run in separate
 * JS contexts, so each builds its own client lazily; everything they share
 * lives in the encrypted database and the Keystore, never in memory.
 */
let client: Promise<ApiClient> | null = null;

export function api(): Promise<ApiClient> {
  client ??= deviceId().then(
    (id) =>
      new ApiClient({
        baseUrl: appConfig().apiUrl,
        sessions: secureSessions,
        fetch: (input, init) => fetch(input, init),
        deviceId: id,
      }),
  );
  return client;
}

/** A fresh UUIDv7 (idempotency keys, telemetry batch ids). */
export function newId(): string {
  return uuidV7(getRandomBytes);
}
