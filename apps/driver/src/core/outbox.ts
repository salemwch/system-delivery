import { z } from "zod";

import { ApiError } from "./api";
import { manifestSchema } from "./manifest";
import type { Manifest } from "./manifest";

/**
 * The device's outbox (docs/08 §8.1): every action a driver takes is written
 * to the encrypted database FIRST, then sent. A delivery recorded in a lift
 * with no signal is a delivery; it reaches the server when the phone does.
 *
 * Each action carries its own idempotency key, minted when the driver tapped
 * (UUIDv7). A retry after a lost answer replays the same key, and the server
 * returns the recorded outcome instead of applying it twice (I29).
 *
 * Results are per item, never all or nothing (the server's `action` says what
 * to do): ACCEPTED is done; DISCARD_AND_REFRESH is refused and shown;
 * RETRY_LATER stays queued; ESCALATE_TO_DISPATCHER stays visible until a
 * person has looked at it. A physical event (a delivery) is never silently
 * dropped.
 *
 * Pure: storage and HTTP are ports, so the whole flush is tested in Vitest
 * against an in-memory store (test/outbox.spec.ts).
 */

/** Replayed through `POST /v1/drivers/me/sync`. */
const SYNC_KINDS = ["DELIVERED", "FAILED", "RETURN_COMPLETED", "ADDRESS_CORRECTED"] as const;
type SyncKind = (typeof SYNC_KINDS)[number];
/** Replayed through the pickup endpoints. */
type PickupKind = "PICKUP_SCAN" | "PICKUP_COLLECT" | "PICKUP_COMPLETE";
export type ActionKind = SyncKind | PickupKind;
export type ActionState = "PENDING" | "DONE" | "REFUSED" | "ESCALATED";

export interface OutboxAction {
  /** The idempotency key, minted on the tap. */
  readonly id: string;
  readonly seq: number;
  readonly kind: ActionKind;
  /** shipmentId (deliveries, failures, returns), addressId (corrections), pickupId (pickups). */
  readonly subjectId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Local media ids, resolved to the server's object keys when sent. */
  readonly media: readonly string[];
  readonly state: ActionState;
  readonly attempts: number;
  readonly code: string | null;
  readonly detail: string | null;
  readonly createdAt: number;
}

export type MediaPurpose = "POD_PHOTO" | "POD_SIGNATURE";
export type MediaState = "CAPTURED" | "SLOTTED" | "UPLOADED" | "FAILED";

export interface MediaItem {
  /** The presign idempotency key: a retry is the same slot, never a second one. */
  readonly id: string;
  readonly shipmentId: string;
  readonly purpose: MediaPurpose;
  readonly uri: string;
  readonly contentType: "image/jpeg" | "image/png";
  readonly sizeBytes: number;
  readonly artifactId: string | null;
  readonly objectKey: string | null;
  readonly state: MediaState;
  readonly code: string | null;
}

export type ActionPatch = Partial<Pick<OutboxAction, "state" | "attempts" | "code" | "detail">>;
export type MediaPatch = Partial<Pick<MediaItem, "state" | "artifactId" | "objectKey" | "code">>;

export interface OutboxStore {
  /** PENDING actions, oldest first. */
  pending(): Promise<OutboxAction[]>;
  updateAction(id: string, patch: ActionPatch): Promise<void>;
  /** Media not yet UPLOADED or FAILED. */
  openMedia(): Promise<MediaItem[]>;
  mediaByIds(ids: readonly string[]): Promise<MediaItem[]>;
  updateMedia(id: string, patch: MediaPatch): Promise<void>;
  /** The manifest version held per active route, for `knownRouteVersions`. */
  routeVersions(): Promise<Record<string, string>>;
  saveRoutes(
    active: readonly { routeId: string; status: string; version: string }[],
    updates: readonly { routeId: string; version: string; manifest: Manifest }[],
  ): Promise<void>;
}

// ── The server's answers ────────────────────────────────────────────────────

const syncActionSchema = z.enum(["DISCARD_AND_REFRESH", "RETRY_LATER", "ESCALATE_TO_DISPATCHER"]);
type SyncAction = z.infer<typeof syncActionSchema>;

export const syncResponseSchema = z
  .object({
    results: z.array(
      z.union([
        z
          .object({
            idempotencyKey: z.string().nullable(),
            status: z.literal("ACCEPTED"),
            resultingStatus: z.string(),
          })
          .loose(),
        z
          .object({
            idempotencyKey: z.string().nullable(),
            status: z.literal("REJECTED"),
            code: z.string(),
            detail: z.string(),
            action: syncActionSchema,
          })
          .loose(),
      ]),
    ),
    activeRoutes: z.array(
      z.object({ routeId: z.uuid(), status: z.string(), version: z.string() }).loose(),
    ),
    routeUpdates: z.array(
      z.object({ routeId: z.uuid(), version: z.string(), manifest: manifestSchema }).loose(),
    ),
    features: z.record(z.string(), z.boolean()),
    serverTime: z.string(),
  })
  .loose();
export type SyncResponse = z.infer<typeof syncResponseSchema>;

export const scanBatchResponseSchema = z
  .object({
    results: z.array(
      z
        .object({
          index: z.number().int(),
          status: z.enum(["ACCEPTED", "REJECTED", "CONFLICT"]),
          action: syncActionSchema.nullable(),
          reason: z.string().nullable(),
        })
        .loose(),
    ),
  })
  .loose();
export type ScanBatchResponse = z.infer<typeof scanBatchResponseSchema>;

export interface MediaSlot {
  readonly artifactId: string;
  readonly objectKey: string;
  /** Null once the slot no longer waits for its upload. */
  readonly uploadUrl: string | null;
  readonly requiredHeaders: Readonly<Record<string, string>> | null;
}

export interface OutboxPorts {
  presign(media: MediaItem): Promise<MediaSlot>;
  upload(media: MediaItem, url: string, headers: Readonly<Record<string, string>>): Promise<void>;
  completeMedia(artifactId: string): Promise<void>;
  /** The local file is no longer needed once the server holds it. */
  discardFile(media: MediaItem): Promise<void>;
  sync(body: {
    readonly knownRouteVersions: Readonly<Record<string, string>>;
    readonly pendingEvents: readonly unknown[];
  }): Promise<SyncResponse>;
  scanBatch(pickupId: string, scans: readonly unknown[]): Promise<ScanBatchResponse>;
  collectPickup(pickupId: string, body: Readonly<Record<string, unknown>>): Promise<void>;
  completePickup(pickupId: string, body: Readonly<Record<string, unknown>>): Promise<void>;
}

export interface FlushReport {
  readonly sent: number;
  readonly refused: number;
  readonly escalated: number;
  /** The server answered at least once: the manifests are fresh. */
  readonly reachedServer: boolean;
  /** Stopped on the network or the server being down; try again later. */
  readonly offline: boolean;
  readonly features: Readonly<Record<string, boolean>> | null;
}

/** The server takes at most 100 sync items and 200 scans per call. */
const MAX_SYNC_ITEMS = 100;
const MAX_SCANS = 200;

const isSyncKind = (kind: ActionKind): kind is SyncKind =>
  (SYNC_KINDS as readonly string[]).includes(kind);

/**
 * Sends everything that can be sent, in the order it happened, and stops at
 * the first sign of being offline (the rest waits; nothing is reordered).
 *
 * 1. Media get their upload SLOTS first: a slot is what gives a photo its
 *    object key, and the delivery that cites the key may be sent before the
 *    photo itself is (the server accepts a cited slot still waiting for its
 *    upload). A 10 MB photo on 3G never holds back a 1 KB delivery.
 * 2. Actions, oldest first, in batches of one kind.
 * 3. One plain sync if no batch reached the server, so the day is refreshed.
 * 4. The photo and signature uploads last.
 */
export async function flushOutbox(store: OutboxStore, ports: OutboxPorts): Promise<FlushReport> {
  const tally = { sent: 0, refused: 0, escalated: 0 };
  let reachedServer = false;
  let features: Readonly<Record<string, boolean>> | null = null;
  const fresh = new Map<string, MediaSlot>();

  const offline = (): FlushReport => ({
    ...tally,
    reachedServer,
    offline: true,
    features,
  });

  // 1. Slots.
  for (const media of await store.openMedia()) {
    if (media.state !== "CAPTURED") continue;
    const outcome = await attempt(() => ports.presign(media));
    if (outcome.kind === "transient") return offline();
    reachedServer = true;
    if (outcome.kind === "refused") {
      await store.updateMedia(media.id, { state: "FAILED", code: outcome.code });
      continue;
    }
    fresh.set(media.id, outcome.value);
    await store.updateMedia(media.id, {
      state: "SLOTTED",
      artifactId: outcome.value.artifactId,
      objectKey: outcome.value.objectKey,
    });
  }

  // 2. Actions. A parcel (or pickup, or address) that must wait holds back
  // only its OWN later actions: they are never sent ahead of it, while
  // everything else carries on.
  let synced = false;
  const deferred = new Set<string>();
  const sendable = async () => (await store.pending()).filter((a) => !deferred.has(a.subjectId));
  let queue = await sendable();
  while (queue.length > 0) {
    const head = queue[0];
    if (head === undefined) break;

    if (isSyncKind(head.kind)) {
      const run = takeWhile(queue, (a) => isSyncKind(a.kind), MAX_SYNC_ITEMS);
      const items: { action: OutboxAction; item: unknown }[] = [];
      for (const action of run) {
        const item = await toSyncItem(store, action);
        // A photo without its slot yet: the parcel waits, and so does the rest
        // of this batch, so nothing overtakes it.
        if (item === null) {
          deferred.add(action.subjectId);
          break;
        }
        items.push({ action, item });
      }
      if (items.length === 0) {
        queue = await sendable();
        continue;
      }
      const outcome = await attempt(async () =>
        ports.sync({
          knownRouteVersions: await store.routeVersions(),
          pendingEvents: items.map((i) => i.item),
        }),
      );
      if (outcome.kind === "transient") return offline();
      reachedServer = true;
      if (outcome.kind === "refused") {
        // The envelope itself was refused: a client defect. Keep everything
        // (it may hold deliveries), count the attempt, and stop.
        for (const { action } of items) {
          await store.updateAction(action.id, {
            attempts: action.attempts + 1,
            code: outcome.code,
            detail: outcome.detail,
          });
        }
        break;
      }
      synced = true;
      features = outcome.value.features;
      await store.saveRoutes(outcome.value.activeRoutes, outcome.value.routeUpdates);
      for (const { action } of items) {
        const result = outcome.value.results.find((r) => r.idempotencyKey === action.id);
        if (result === undefined) {
          deferred.add(action.subjectId);
        } else if (result.status === "ACCEPTED") {
          await store.updateAction(action.id, { state: "DONE", code: null, detail: null });
          tally.sent += 1;
        } else {
          if (result.action === "RETRY_LATER") deferred.add(action.subjectId);
          await settle(store, action, result.action, result.code, result.detail, tally);
        }
      }
    } else if (head.kind === "PICKUP_SCAN") {
      const run = takeWhile(
        queue,
        (a) => a.kind === "PICKUP_SCAN" && a.subjectId === head.subjectId,
        MAX_SCANS,
      );
      const outcome = await attempt(() =>
        ports.scanBatch(
          head.subjectId,
          run.map((a) => ({ ...a.payload, idempotencyKey: a.id })),
        ),
      );
      if (outcome.kind === "transient") return offline();
      reachedServer = true;
      if (outcome.kind === "refused") {
        for (const action of run) {
          await store.updateAction(action.id, {
            state: "REFUSED",
            code: outcome.code,
            detail: outcome.detail,
          });
          tally.refused += 1;
        }
      } else {
        for (const [index, action] of run.entries()) {
          const result = outcome.value.results.find((r) => r.index === index);
          if (result === undefined) {
            deferred.add(action.subjectId);
          } else if (result.action === null) {
            await store.updateAction(action.id, { state: "DONE" });
            tally.sent += 1;
          } else {
            if (result.action === "RETRY_LATER") deferred.add(action.subjectId);
            await settle(store, action, result.action, result.status, result.reason ?? "", tally);
          }
        }
      }
    } else {
      const body = { ...head.payload, idempotencyKey: head.id };
      const outcome = await attempt(() =>
        head.kind === "PICKUP_COLLECT"
          ? ports.collectPickup(head.subjectId, body)
          : ports.completePickup(head.subjectId, body),
      );
      if (outcome.kind === "transient") return offline();
      reachedServer = true;
      if (outcome.kind === "refused") {
        await store.updateAction(head.id, {
          state: "REFUSED",
          code: outcome.code,
          detail: outcome.detail,
        });
        tally.refused += 1;
      } else {
        await store.updateAction(head.id, { state: "DONE" });
        tally.sent += 1;
      }
    }
    queue = await sendable();
  }

  // 3. Refresh the day when no batch did.
  if (!synced) {
    const outcome = await attempt(async () =>
      ports.sync({ knownRouteVersions: await store.routeVersions(), pendingEvents: [] }),
    );
    if (outcome.kind === "transient") return offline();
    if (outcome.kind === "ok") {
      reachedServer = true;
      features = outcome.value.features;
      await store.saveRoutes(outcome.value.activeRoutes, outcome.value.routeUpdates);
    }
  }

  // 4. Uploads.
  for (const media of await store.openMedia()) {
    if (media.state !== "SLOTTED" || media.artifactId === null) continue;
    const artifactId = media.artifactId;
    const outcome = await attempt(async () => {
      // A slot's URL expires; asking again with the same key returns the same
      // slot with a fresh URL (or none once the upload already landed).
      const slot = fresh.get(media.id) ?? (await ports.presign(media));
      if (slot.uploadUrl !== null) {
        await ports.upload(media, slot.uploadUrl, slot.requiredHeaders ?? {});
      }
      await ports.completeMedia(artifactId);
    });
    if (outcome.kind === "transient") return offline();
    reachedServer = true;
    if (outcome.kind === "refused") {
      await store.updateMedia(media.id, { state: "FAILED", code: outcome.code });
    } else {
      await store.updateMedia(media.id, { state: "UPLOADED", code: null });
      await ports.discardFile(media);
    }
  }

  return { ...tally, reachedServer, offline: false, features };
}

async function settle(
  store: OutboxStore,
  action: OutboxAction,
  verdict: SyncAction,
  code: string,
  detail: string,
  tally: { refused: number; escalated: number },
): Promise<void> {
  if (verdict === "RETRY_LATER") {
    await store.updateAction(action.id, { attempts: action.attempts + 1, code, detail });
  } else if (verdict === "DISCARD_AND_REFRESH" && !isPhysical(action.kind)) {
    await store.updateAction(action.id, { state: "REFUSED", code, detail });
    tally.refused += 1;
  } else {
    // A refused delivery or return happened in the street whatever the server
    // says: a person must look at it (the server escalates these too).
    await store.updateAction(action.id, { state: "ESCALATED", code, detail });
    tally.escalated += 1;
  }
}

function isPhysical(kind: ActionKind): boolean {
  return kind === "DELIVERED" || kind === "RETURN_COMPLETED";
}

/** The sync item for an action, or null while one of its photos has no slot yet. */
async function toSyncItem(store: OutboxStore, action: OutboxAction): Promise<unknown> {
  const media = action.media.length === 0 ? [] : await store.mediaByIds(action.media);
  if (media.some((m) => m.state === "CAPTURED")) {
    return null;
  }
  const key = (purpose: MediaPurpose) =>
    media
      .filter((m) => m.purpose === purpose && m.objectKey !== null && m.state !== "FAILED")
      .map((m) => m.objectKey ?? "");
  let payload: Record<string, unknown> = { ...action.payload };
  const pod = payload["pod"];
  if (action.kind === "DELIVERED" && typeof pod === "object" && pod !== null) {
    const [signature] = key("POD_SIGNATURE");
    const photos = key("POD_PHOTO");
    payload = {
      ...payload,
      pod: {
        ...pod,
        ...(signature === undefined ? {} : { signatureObjectKey: signature }),
        ...(photos.length === 0 ? {} : { photoObjectKeys: photos }),
      },
    };
  }
  return {
    idempotencyKey: action.id,
    type: action.kind,
    ...(action.kind === "ADDRESS_CORRECTED"
      ? { addressId: action.subjectId }
      : { shipmentId: action.subjectId }),
    payload,
  };
}

function takeWhile<T>(items: readonly T[], keep: (item: T) => boolean, max: number): T[] {
  const out: T[] = [];
  for (const item of items) {
    if (out.length >= max || !keep(item)) break;
    out.push(item);
  }
  return out;
}

type Attempt<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "transient" }
  | { readonly kind: "refused"; readonly code: string; readonly detail: string };

/**
 * A call's outcome as data. Transient (network, timeout, 5xx, 429, and a 401
 * the client could not refresh) means "later"; any other API refusal is the
 * server's answer about THIS item. Anything else is a local defect and throws.
 */
async function attempt<T>(call: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { kind: "ok", value: await call() };
  } catch (error) {
    if (!(error instanceof ApiError)) {
      throw error;
    }
    if (error.transient || error.status === 401) {
      return { kind: "transient" };
    }
    return { kind: "refused", code: error.code, detail: error.message };
  }
}
