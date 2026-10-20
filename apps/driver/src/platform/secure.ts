import { getRandomBytes } from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { z } from "zod";

import type { Session, SessionStore } from "../core/api";
import { uuidV7 } from "../core/ids";

/**
 * Secrets in the Android Keystore (expo-secure-store): the session, the
 * device id, and the key that encrypts the local database (docs/08 §8.1:
 * "Keystore-backed tokens, encrypted local DB").
 *
 * Readable while the screen is locked on purpose: the background location
 * task uploads from a phone in a pocket. The keys are bound to this install
 * (`allowBackup: false`), never synced or restored elsewhere.
 */
/** v2 carries the user id; a v1 session is simply signed in again. */
const SESSION_KEY = "session.v2";
const DEVICE_KEY = "device.id.v1";
const DB_KEY = "db.key.v1";

const sessionSchema = z.object({
  tenantId: z.uuid(),
  userId: z.uuid(),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number(),
});

export const secureSessions: SessionStore = {
  async load(): Promise<Session | null> {
    const raw = await SecureStore.getItemAsync(SESSION_KEY);
    if (raw === null) {
      return null;
    }
    const parsed = sessionSchema.safeParse(safeJson(raw));
    if (!parsed.success) {
      // Unreadable (an older format, a corrupted write): sign in again rather
      // than act on a half-read session.
      await SecureStore.deleteItemAsync(SESSION_KEY);
      return null;
    }
    return parsed.data;
  },
  async save(session: Session): Promise<void> {
    await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session));
  },
  async clear(): Promise<void> {
    await SecureStore.deleteItemAsync(SESSION_KEY);
  },
};

/** A stable id for this install, minted once (UUIDv7). */
export async function deviceId(): Promise<string> {
  const existing = await SecureStore.getItemAsync(DEVICE_KEY);
  if (existing !== null) {
    return existing;
  }
  const id = uuidV7(getRandomBytes);
  await SecureStore.setItemAsync(DEVICE_KEY, id);
  return id;
}

/** 256-bit SQLCipher key, generated on first use and kept in the Keystore. */
export async function databaseKey(): Promise<string> {
  const existing = await SecureStore.getItemAsync(DB_KEY);
  if (existing !== null) {
    return existing;
  }
  const key = Array.from(getRandomBytes(32), (b) => b.toString(16).padStart(2, "0")).join("");
  await SecureStore.setItemAsync(DB_KEY, key);
  return key;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
