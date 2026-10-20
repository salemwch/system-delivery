import { useSyncExternalStore } from "react";
import { ApiError } from "../core/api";
import { currentShift } from "../core/endpoints";
import type { CurrentShift } from "../core/endpoints";
import { bootstrap, bootstrapSchema, outboxPorts } from "../core/field-endpoints";
import type { Bootstrap } from "../core/field-endpoints";
import type { Manifest, Pending } from "../core/manifest";
import { flushOutbox } from "../core/outbox";
import type { ActionKind, OutboxAction } from "../core/outbox";
import { readMeta, writeMeta } from "../platform/database";
import { fileUploader } from "../platform/media";
import {
  enqueue,
  pendingOutcomes,
  pruneActions,
  recentActions,
  sqliteOutbox,
  storedManifests,
} from "../platform/outbox-store";
import type { NewMedia } from "../platform/outbox-store";
import { deviceId } from "../platform/secure";
import { api } from "./runtime";

/**
 * The field state every screen reads: today's manifests with the device's
 * unsent outcomes laid over them, the outbox, the shift and the courier's
 * configuration. One store (React's useSyncExternalStore, no extra library);
 * the database is the truth and this is its in-memory reflection.
 */
export interface FieldState {
  /** Routes the server lists as the driver's today (PUBLISHED, IN_PROGRESS). */
  readonly manifests: readonly Manifest[];
  /** Plus today's routes the server no longer lists (completed): for the cash. */
  readonly todayManifests: readonly Manifest[];
  readonly pending: readonly Pending[];
  /** Today's actions, newest first. */
  readonly actions: readonly OutboxAction[];
  readonly config: Bootstrap | null;
  readonly shift: CurrentShift | null;
  readonly features: Readonly<Record<string, boolean>>;
  readonly lastSyncAt: number | null;
  readonly syncing: boolean;
  readonly offline: boolean;
  readonly loaded: boolean;
}

let state: FieldState = {
  manifests: [],
  todayManifests: [],
  pending: [],
  actions: [],
  config: null,
  shift: null,
  features: {},
  lastSyncAt: null,
  syncing: false,
  offline: false,
  loaded: false,
};
const listeners = new Set<() => void>();

function set(patch: Partial<FieldState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useField(): FieldState {
  return useSyncExternalStore(subscribe, () => state);
}

/** The device's local date (YYYY-MM-DD), the day routes are planned for. */
export function today(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function startOfDay(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

const META = {
  config: "field.config",
  configAt: "field.configAt",
  lastSyncAt: "field.lastSyncAt",
} as const;

/** The courier's configuration is re-read at most hourly (failure reasons rarely move). */
const CONFIG_TTL_MS = 60 * 60_000;
const WEEK_MS = 7 * 24 * 60 * 60_000;

/** Re-reads the database into the store. Cheap; called after every write. */
export async function reload(): Promise<void> {
  const [{ active, all }, pending, actions, lastSync, rawConfig] = await Promise.all([
    storedManifests(today()),
    pendingOutcomes(),
    recentActions(startOfDay()),
    readMeta(META.lastSyncAt),
    state.config === null ? readMeta(META.config) : Promise.resolve(null),
  ]);
  const cached = rawConfig === null ? null : parseConfig(rawConfig);
  set({
    manifests: active,
    todayManifests: all,
    pending,
    actions,
    lastSyncAt: lastSync === null ? null : Number(lastSync),
    ...(cached === null ? {} : { config: cached }),
    loaded: true,
  });
}

let flushing: Promise<void> | null = null;

/**
 * Sends the outbox and refreshes the day. Single-flight: a second call while
 * one runs joins it, so two taps never send the same batch twice at once.
 */
export function syncNow(): Promise<void> {
  flushing ??= runSync().finally(() => {
    flushing = null;
  });
  return flushing;
}

async function runSync(): Promise<void> {
  set({ syncing: true });
  try {
    const client = await api();
    const report = await flushOutbox(
      sqliteOutbox,
      outboxPorts(client, await deviceId(), fileUploader),
    );
    if (report.reachedServer) {
      await writeMeta(META.lastSyncAt, String(Date.now()));
    }
    set({
      offline: report.offline,
      ...(report.features === null ? {} : { features: report.features }),
    });
    if (!report.offline) {
      await Promise.all([refreshConfig(), refreshShift()]);
      await pruneActions(Date.now() - WEEK_MS);
    }
  } catch (error) {
    // A local failure (the database) or an unexpected answer: the outbox is
    // intact, the next sync tries again. Shown as offline, never swallowed.
    set({ offline: true });
    if (!(error instanceof ApiError)) {
      throw error;
    }
  } finally {
    await reload();
    set({ syncing: false });
  }
}

async function refreshConfig(): Promise<void> {
  const at = Number((await readMeta(META.configAt)) ?? "0");
  if (state.config !== null && Date.now() - at < CONFIG_TTL_MS) return;
  try {
    const config = await bootstrap(await api());
    await writeMeta(META.config, JSON.stringify(config));
    await writeMeta(META.configAt, String(Date.now()));
    set({ config });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    // Keep the cached configuration; failure reasons from yesterday still work.
  }
}

/** The server's view of the shift. Null while unknown (offline). */
export async function refreshShift(): Promise<CurrentShift | null> {
  try {
    const shift = await currentShift(await api());
    set({ shift });
    return shift;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return null;
  }
}

/**
 * Records what the driver just did, then tries to send it. The record is
 * written before anything else happens: the screen can close, the phone can
 * die, and the action is still there.
 */
export async function record(
  action: {
    readonly id: string;
    readonly kind: ActionKind;
    readonly subjectId: string;
    readonly payload: Readonly<Record<string, unknown>>;
  },
  media: readonly NewMedia[] = [],
): Promise<void> {
  await enqueue(action, media);
  await reload();
  void syncNow().catch(() => undefined);
}

function parseConfig(raw: string): Bootstrap | null {
  try {
    const parsed = bootstrapSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Clears the in-memory reflection on sign-out. */
export function resetField(): void {
  set({
    manifests: [],
    todayManifests: [],
    pending: [],
    actions: [],
    shift: null,
    features: {},
    lastSyncAt: null,
    offline: false,
  });
}
