import type { Scalar } from "@op-engineering/op-sqlite";

import { manifestSchema } from "../core/manifest";
import type { Manifest, Pending } from "../core/manifest";
import type {
  ActionKind,
  ActionPatch,
  ActionState,
  MediaItem,
  MediaPatch,
  MediaPurpose,
  MediaState,
  OutboxAction,
  OutboxStore,
} from "../core/outbox";
import { database } from "./database";

/**
 * The outbox, its media and the day's manifests in SQLCipher, implementing
 * the contract core/outbox.ts relies on (test/memory-outbox.ts is the
 * reference). Nothing a driver recorded lives only in memory.
 */

type Row = Record<string, Scalar>;

const str = (row: Row, key: string): string => {
  const value = row[key];
  return typeof value === "string" ? value : "";
};
const strOrNull = (row: Row, key: string): string | null => {
  const value = row[key];
  return typeof value === "string" ? value : null;
};
const num = (row: Row, key: string): number => {
  const value = row[key];
  return typeof value === "number" ? value : 0;
};

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const ACTION_KINDS: ReadonlySet<string> = new Set<ActionKind>([
  "DELIVERED",
  "FAILED",
  "RETURN_COMPLETED",
  "ADDRESS_CORRECTED",
  "PICKUP_SCAN",
  "PICKUP_COLLECT",
  "PICKUP_COMPLETE",
]);
const isKind = (value: string): value is ActionKind => ACTION_KINDS.has(value);
const ACTION_STATES: ReadonlySet<string> = new Set<ActionState>([
  "PENDING",
  "DONE",
  "REFUSED",
  "ESCALATED",
]);
const isActionState = (value: string): value is ActionState => ACTION_STATES.has(value);
const MEDIA_STATES: ReadonlySet<string> = new Set<MediaState>([
  "CAPTURED",
  "SLOTTED",
  "UPLOADED",
  "FAILED",
]);
const isMediaState = (value: string): value is MediaState => MEDIA_STATES.has(value);

function toAction(row: Row): OutboxAction | null {
  const kind = str(row, "kind");
  const state = str(row, "state");
  const payload = parseJson(str(row, "payload"));
  const media = parseJson(str(row, "media"));
  if (!isKind(kind) || !isActionState(state) || typeof payload !== "object" || payload === null) {
    return null;
  }
  return {
    id: str(row, "id"),
    seq: num(row, "seq"),
    kind,
    subjectId: str(row, "subject_id"),
    payload: { ...payload },
    media: Array.isArray(media) ? media.filter((m): m is string => typeof m === "string") : [],
    state,
    attempts: num(row, "attempts"),
    code: strOrNull(row, "code"),
    detail: strOrNull(row, "detail"),
    createdAt: num(row, "created_at"),
  };
}

function toMedia(row: Row): MediaItem | null {
  const purpose = str(row, "purpose");
  const contentType = str(row, "content_type");
  const state = str(row, "state");
  if (
    (purpose !== "POD_PHOTO" && purpose !== "POD_SIGNATURE") ||
    (contentType !== "image/jpeg" && contentType !== "image/png") ||
    !isMediaState(state)
  ) {
    return null;
  }
  return {
    id: str(row, "id"),
    shipmentId: str(row, "shipment_id"),
    purpose,
    uri: str(row, "uri"),
    contentType,
    sizeBytes: num(row, "size_bytes"),
    artifactId: strOrNull(row, "artifact_id"),
    objectKey: strOrNull(row, "object_key"),
    state,
    code: strOrNull(row, "code"),
  };
}

const present = <T>(value: T | null): value is T => value !== null;

/** Column ↔ patch field; only these columns are ever written from a patch. */
const ACTION_COLUMNS = {
  state: "state",
  attempts: "attempts",
  code: "code",
  detail: "detail",
} as const;
const MEDIA_COLUMNS = {
  state: "state",
  artifactId: "artifact_id",
  objectKey: "object_key",
  code: "code",
} as const;

function assignments<P extends object>(
  patch: P,
  columns: Readonly<Record<string, string>>,
): { sql: string; values: Scalar[] } {
  const parts: string[] = [];
  const values: Scalar[] = [];
  for (const [field, value] of Object.entries(patch)) {
    const column = columns[field];
    if (column === undefined || value === undefined) continue;
    parts.push(`${column} = ?`);
    values.push(typeof value === "string" || typeof value === "number" ? value : null);
  }
  return { sql: parts.join(", "), values };
}

export const sqliteOutbox: OutboxStore = {
  async pending(): Promise<OutboxAction[]> {
    const db = await database();
    const result = await db.execute("SELECT * FROM actions WHERE state = 'PENDING' ORDER BY seq");
    return result.rows.map(toAction).filter(present);
  },

  async updateAction(id: string, patch: ActionPatch): Promise<void> {
    const { sql, values } = assignments(patch, ACTION_COLUMNS);
    if (sql === "") return;
    const db = await database();
    await db.execute(`UPDATE actions SET ${sql} WHERE id = ?`, [...values, id]);
  },

  async openMedia(): Promise<MediaItem[]> {
    const db = await database();
    const result = await db.execute(
      "SELECT * FROM media WHERE state IN ('CAPTURED', 'SLOTTED') ORDER BY created_at",
    );
    return result.rows.map(toMedia).filter(present);
  },

  async mediaByIds(ids: readonly string[]): Promise<MediaItem[]> {
    if (ids.length === 0) return [];
    const db = await database();
    const result = await db.execute(
      `SELECT * FROM media WHERE id IN (${ids.map(() => "?").join(", ")})`,
      [...ids],
    );
    return result.rows.map(toMedia).filter(present);
  },

  async updateMedia(id: string, patch: MediaPatch): Promise<void> {
    const { sql, values } = assignments(patch, MEDIA_COLUMNS);
    if (sql === "") return;
    const db = await database();
    await db.execute(`UPDATE media SET ${sql} WHERE id = ?`, [...values, id]);
  },

  async routeVersions(): Promise<Record<string, string>> {
    const db = await database();
    const result = await db.execute("SELECT route_id, version FROM routes WHERE active = 1");
    return Object.fromEntries(
      result.rows.map((row) => [str(row, "route_id"), str(row, "version")]),
    );
  },

  async saveRoutes(active, updates): Promise<void> {
    const db = await database();
    const now = Date.now();
    await db.transaction(async (tx) => {
      // A route the server no longer lists (completed, re-planned) stays on the
      // device for the day, inactive: its cash is still in the driver's pocket.
      await tx.execute("UPDATE routes SET active = 0");
      for (const update of updates) {
        await tx.execute(
          `INSERT INTO routes (route_id, version, status, active, planned_date, manifest, updated_at)
           VALUES (?, ?, ?, 1, ?, ?, ?)
           ON CONFLICT(route_id) DO UPDATE SET version = excluded.version, status = excluded.status,
             active = 1, planned_date = excluded.planned_date, manifest = excluded.manifest,
             updated_at = excluded.updated_at`,
          [
            update.routeId,
            update.version,
            update.manifest.status,
            update.manifest.plannedDate,
            JSON.stringify(update.manifest),
            now,
          ],
        );
      }
      for (const route of active) {
        await tx.execute("UPDATE routes SET active = 1, status = ? WHERE route_id = ?", [
          route.status,
          route.routeId,
        ]);
      }
    });
  },
};

// ── What the screens read and write ─────────────────────────────────────────

export interface NewMedia {
  readonly id: string;
  readonly shipmentId: string;
  readonly purpose: MediaPurpose;
  readonly uri: string;
  readonly contentType: "image/jpeg" | "image/png";
  readonly sizeBytes: number;
}

/** Records an action (and its media) in one transaction: both or neither. */
export async function enqueue(
  action: {
    readonly id: string;
    readonly kind: ActionKind;
    readonly subjectId: string;
    readonly payload: Readonly<Record<string, unknown>>;
  },
  media: readonly NewMedia[] = [],
): Promise<void> {
  const db = await database();
  const now = Date.now();
  await db.transaction(async (tx) => {
    for (const m of media) {
      await tx.execute(
        `INSERT INTO media (id, shipment_id, purpose, uri, content_type, size_bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [m.id, m.shipmentId, m.purpose, m.uri, m.contentType, m.sizeBytes, now],
      );
    }
    await tx.execute(
      `INSERT INTO actions (id, kind, subject_id, payload, media, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        action.id,
        action.kind,
        action.subjectId,
        JSON.stringify(action.payload),
        JSON.stringify(media.map((m) => m.id)),
        now,
      ],
    );
  });
}

/** Every action recorded since `since` (epoch ms), newest first. */
export async function recentActions(since: number): Promise<OutboxAction[]> {
  const db = await database();
  const result = await db.execute("SELECT * FROM actions WHERE created_at >= ? ORDER BY seq DESC", [
    since,
  ]);
  return result.rows.map(toAction).filter(present);
}

/** Outcomes the server has not confirmed yet, laid over the manifests. */
export async function pendingOutcomes(): Promise<Pending[]> {
  const db = await database();
  const result = await db.execute(
    `SELECT kind, subject_id FROM actions
      WHERE state IN ('PENDING', 'ESCALATED') AND kind IN ('DELIVERED', 'FAILED', 'RETURN_COMPLETED')
      ORDER BY seq`,
  );
  return result.rows.flatMap((row): Pending[] => {
    const kind = str(row, "kind");
    return kind === "DELIVERED" || kind === "FAILED" || kind === "RETURN_COMPLETED"
      ? [{ shipmentId: str(row, "subject_id"), outcome: kind }]
      : [];
  });
}

/** Local pickup scans not refused, for the scan screen's instant feedback. */
export async function localScans(pickupId: string): Promise<string[]> {
  const db = await database();
  const result = await db.execute(
    `SELECT payload FROM actions
      WHERE kind = 'PICKUP_SCAN' AND subject_id = ? AND state IN ('PENDING', 'DONE')`,
    [pickupId],
  );
  return result.rows.flatMap((row) => {
    const payload = parseJson(str(row, "payload"));
    return typeof payload === "object" &&
      payload !== null &&
      "trackingNumber" in payload &&
      typeof payload.trackingNumber === "string"
      ? [payload.trackingNumber]
      : [];
  });
}

/**
 * The driver has read a refused item, or told dispatch about an escalated
 * one: kept for the record (its code stays), no longer shown.
 */
export async function dismiss(id: string): Promise<void> {
  const db = await database();
  await db.execute(
    "UPDATE actions SET state = 'DONE' WHERE id = ? AND state IN ('REFUSED', 'ESCALATED')",
    [id],
  );
}

/** Today's manifests (active first); routes of earlier days are dropped. */
export async function storedManifests(today: string): Promise<{
  readonly active: Manifest[];
  readonly all: Manifest[];
}> {
  const db = await database();
  await db.execute("DELETE FROM routes WHERE planned_date < ? AND active = 0", [today]);
  const result = await db.execute("SELECT manifest, active FROM routes ORDER BY active DESC");
  const active: Manifest[] = [];
  const all: Manifest[] = [];
  for (const row of result.rows) {
    const parsed = manifestSchema.safeParse(parseJson(str(row, "manifest")));
    if (!parsed.success) continue;
    all.push(parsed.data);
    if (num(row, "active") === 1) active.push(parsed.data);
  }
  return { active, all };
}

/** Housekeeping: settled actions older than a week. */
export async function pruneActions(olderThan: number): Promise<void> {
  const db = await database();
  await db.execute("DELETE FROM actions WHERE state = 'DONE' AND created_at < ?", [olderThan]);
  await db.execute("DELETE FROM media WHERE state IN ('UPLOADED', 'FAILED') AND created_at < ?", [
    olderThan,
  ]);
}

/** Everything this login recorded, on sign-out. Nothing is left for the next driver. */
export async function wipeFieldData(): Promise<void> {
  const db = await database();
  await db.transaction(async (tx) => {
    await tx.execute("DELETE FROM actions");
    await tx.execute("DELETE FROM media");
    await tx.execute("DELETE FROM routes");
  });
}

/**
 * What would be lost if the phone forgot everything now: actions not yet
 * accepted (or escalated and not yet seen by dispatch), and proof files the
 * server does not hold yet.
 */
export async function unsafeToForget(): Promise<number> {
  const db = await database();
  const actions = await db.execute(
    "SELECT COUNT(*) AS n FROM actions WHERE state IN ('PENDING', 'ESCALATED')",
  );
  const media = await db.execute(
    "SELECT COUNT(*) AS n FROM media WHERE state IN ('CAPTURED', 'SLOTTED')",
  );
  return Number(actions.rows[0]?.["n"] ?? 0) + Number(media.rows[0]?.["n"] ?? 0);
}
