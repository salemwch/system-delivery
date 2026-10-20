import { z } from "zod";

import { ApiError } from "../core/api";
import {
  myPickups,
  pickup as fetchPickup,
  pickupParcels,
  pickupSchema,
} from "../core/field-endpoints";
import type { Pickup, PickupManifest } from "../core/field-endpoints";
import { readMeta, writeMeta } from "../platform/database";
import { secureSessions } from "../platform/secure";
import { api } from "./runtime";

/**
 * The driver's pickups: read from the server when there is signal, and the
 * last list kept on the device, so the morning's collections are still on
 * screen in a merchant's basement.
 */
const CACHE = "pickups.cache";
const cacheSchema = z.array(pickupSchema);

export async function cachedPickups(): Promise<Pickup[]> {
  const raw = await readMeta(CACHE);
  if (raw === null) return [];
  try {
    const parsed = cacheSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** Fresh from the server, or null when offline (the caller keeps the cache). */
export async function refreshPickups(): Promise<Pickup[] | null> {
  const session = await secureSessions.load();
  if (session === null) return null;
  try {
    const list = await myPickups(await api(), session.userId);
    await writeMeta(CACHE, JSON.stringify(list));
    return list;
  } catch (error) {
    if (error instanceof ApiError && (error.transient || error.status === 401)) return null;
    throw error;
  }
}

export interface PickupDetail {
  readonly pickup: Pickup;
  readonly parcels: PickupManifest | null;
}

/** One pickup with its expected parcels; the cached row when offline. */
export async function pickupDetail(id: string): Promise<PickupDetail | null> {
  try {
    const client = await api();
    const [row, parcels] = await Promise.all([fetchPickup(client, id), pickupParcels(client, id)]);
    return { pickup: row, parcels };
  } catch (error) {
    if (!(error instanceof ApiError) || !(error.transient || error.status === 401)) throw error;
    const cached = (await cachedPickups()).find((p) => p.id === id);
    return cached === undefined ? null : { pickup: cached, parcels: null };
  }
}
