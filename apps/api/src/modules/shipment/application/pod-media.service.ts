import { createHash } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, ne } from "drizzle-orm";

import {
  DatabaseService,
  TenantContext,
  generateUuidV7,
  isUniqueViolation,
} from "../../../shared/database/index.js";
import type { TenantTransaction } from "../../../shared/database/index.js";
import {
  ConflictError,
  DomainError,
  NotFoundError,
  UnauthenticatedError,
  idempotencyKeyReused,
} from "../../../shared/errors/index.js";
import { parseWithZod, requestFingerprint } from "../../../shared/http/index.js";
import {
  MALWARE_SCANNER,
  OBJECT_STORAGE,
  ObjectTooLargeError,
} from "../../../shared/storage/index.js";
import type { MalwareScanner, ObjectStorage } from "../../../shared/storage/index.js";
import { MAX_POD_MEDIA_BYTES, presignMediaSchema } from "../domain/dtos.js";
import type { PodMediaPurpose } from "../domain/dtos.js";
import { inspectImage } from "../domain/media-inspection.js";
import type { MediaContentType } from "../domain/media-inspection.js";
import { podArtifacts, shipments } from "../domain/schema.js";
import type { PodArtifact } from "../domain/schema.js";

type PodArtifactStatus = "PENDING_UPLOAD" | "PENDING_SCAN" | "AVAILABLE" | "REJECTED";

export interface PodArtifactView {
  readonly id: string;
  readonly shipmentId: string;
  readonly purpose: PodMediaPurpose;
  readonly objectKey: string;
  readonly contentType: MediaContentType;
  readonly sizeBytes: number;
  readonly status: PodArtifactStatus;
  readonly rejectionReason: string | null;
  readonly sha256: string | null;
  readonly createdAt: Date;
  readonly verifiedAt: Date | null;
}

export interface PresignOutcome {
  readonly artifact: PodArtifactView;
  /** Null once the slot is no longer waiting for its upload. */
  readonly upload: {
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly expiresInSeconds: number;
  } | null;
  readonly replayed: boolean;
}

/**
 * A slot is issued only while the parcel is out for delivery: the delivery
 * command must cite the issued key, so a slot opened afterwards could never
 * become part of the proof. The UPLOAD and its verification are not bound to
 * the status: the app is offline-first, and the delivery event routinely syncs
 * before a 3 MB photo finishes uploading.
 */
const MEDIA_STATUSES: ReadonlySet<string> = new Set(["OUT_FOR_DELIVERY"]);

/**
 * Per shipment, counting every slot not REJECTED (a rejected one is replaced by
 * a new capture). A signature is one; five photos is more than any doorstep
 * needs, and a cap is what stops one compromised phone filling the bucket.
 */
const MAX_SLOTS: Readonly<Record<PodMediaPurpose, number>> = { POD_SIGNATURE: 1, POD_PHOTO: 5 };

const KEY_CONSTRAINT = "pod_artifacts_tenant_idempotency_uq";

/**
 * POD photos and signatures (docs/01-mvp-scope.md 4.5, docs/05 §8, docs/07 §7.1).
 *
 *   1. `presign` issues a slot: a row, a key under
 *      `tenant/{tenant}/pod/{shipment}/`, and a URL that accepts one PUT of
 *      exactly the declared type and size. The binary never passes through the
 *      API.
 *   2. The phone uploads straight to storage.
 *   3. `complete` reads the object back and verifies it: the size, the real
 *      type from its magic bytes, no EXIF/XMP block, then the malware scan.
 *      Records the SHA-256 as tamper evidence.
 *
 * Which shipments a caller may attach media to is RLS: a driver session sees
 * only parcels they hold (I28), so a colleague's is a 404.
 *
 * Storage I/O never runs inside a database transaction: a slow store would
 * otherwise hold a connection per driver. `complete` reads first, then decides
 * under the row lock, and a second concurrent `complete` finds the work done.
 */
@Injectable()
export class PodMediaService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
  ) {}

  async presign(input: unknown): Promise<PresignOutcome> {
    const dto = parseWithZod(presignMediaSchema, input);
    const actor = requireActor();
    const requestHash = requestFingerprint(dto);

    let outcome: { readonly artifact: PodArtifact; readonly replayed: boolean };
    try {
      outcome = await this.database.withTenant(async (tx) => {
        const early = await replayOf(tx, dto.idempotencyKey, actor.userId, requestHash);
        if (early !== undefined) {
          return { artifact: early, replayed: true };
        }

        // Locked: serialises slots for one parcel, so the per-shipment cap holds
        // under concurrency and an identical racing retry becomes a replay.
        const locked = await tx
          .select({ id: shipments.id, status: shipments.status })
          .from(shipments)
          .where(eq(shipments.id, dto.shipmentId))
          .for("update");
        const shipment = locked[0];
        if (shipment === undefined) {
          throw new NotFoundError("Shipment");
        }
        const raced = await replayOf(tx, dto.idempotencyKey, actor.userId, requestHash);
        if (raced !== undefined) {
          return { artifact: raced, replayed: true };
        }
        if (!MEDIA_STATUSES.has(shipment.status)) {
          throw new ConflictError(
            "MEDIA_NOT_ACCEPTED",
            `A ${shipment.status} shipment takes no proof-of-delivery media`,
          );
        }

        const used = await tx
          .select({ value: count() })
          .from(podArtifacts)
          .where(
            and(
              eq(podArtifacts.shipmentId, dto.shipmentId),
              eq(podArtifacts.purpose, dto.purpose),
              ne(podArtifacts.status, "REJECTED"),
            ),
          );
        if ((used[0]?.value ?? 0) >= MAX_SLOTS[dto.purpose]) {
          throw new ConflictError(
            "MEDIA_LIMIT_REACHED",
            `This shipment already has ${String(MAX_SLOTS[dto.purpose])} ${dto.purpose} upload(s)`,
          );
        }

        const tenantId = TenantContext.requireTenantId();
        const id = await generateUuidV7(tx);
        const extension = dto.contentType === "image/png" ? "png" : "jpg";
        const inserted = await tx
          .insert(podArtifacts)
          .values({
            id,
            tenantId,
            shipmentId: dto.shipmentId,
            uploadedByUserId: actor.userId,
            driverId: actor.driverId,
            purpose: dto.purpose,
            // Server-built, never client-supplied: the prefix names the tenant
            // and the parcel, and a CHECK constraint holds it to that.
            objectKey: `tenant/${tenantId}/pod/${dto.shipmentId}/${id}.${extension}`,
            contentType: dto.contentType,
            sizeBytes: dto.sizeBytes,
            idempotencyKey: dto.idempotencyKey,
            requestHash,
          })
          .returning();
        const artifact = inserted[0];
        if (artifact === undefined) {
          throw new Error("POD artifact insert returned no row");
        }
        return { artifact, replayed: false };
      });
    } catch (error) {
      if (isUniqueViolation(error, KEY_CONSTRAINT)) {
        throw idempotencyKeyReused();
      }
      throw error;
    }

    const { artifact } = outcome;
    return {
      artifact: toView(artifact),
      // A replay of a slot still waiting gets a FRESH URL: the first one may
      // have expired while the phone was offline.
      upload:
        artifact.status === "PENDING_UPLOAD"
          ? this.storage.presignPut(artifact.objectKey, {
              contentType: artifact.contentType,
              contentLength: artifact.sizeBytes,
            })
          : null,
      replayed: outcome.replayed,
    };
  }

  /**
   * Verifies an uploaded slot. Idempotent: a slot already decided is returned
   * as it is. Nothing uploaded yet is `409 MEDIA_NOT_UPLOADED` and changes
   * nothing, so the app retries; a file that fails verification is REJECTED
   * for good and the driver captures again.
   */
  async complete(artifactId: string): Promise<PodArtifactView> {
    requireActor();
    const artifact = await this.database.withTenant((tx) => findArtifact(tx, artifactId));
    if (artifact.status !== "PENDING_UPLOAD") {
      return toView(artifact);
    }

    const verdict = await this.verify(artifact);
    const scan = verdict.ok ? await this.scanner.scan(verdict.bytes) : null;

    return this.database.withTenant(async (tx) => {
      const locked = (
        await tx.select().from(podArtifacts).where(eq(podArtifacts.id, artifactId)).for("update")
      )[0];
      if (locked === undefined) {
        throw new NotFoundError("POD media");
      }
      if (locked.status !== "PENDING_UPLOAD") {
        // A concurrent complete got here first; its decision stands.
        return toView(locked);
      }
      if (!verdict.ok) {
        return toView(
          await update(tx, artifactId, { status: "REJECTED", rejectionReason: verdict.reason }),
        );
      }
      const now = new Date();
      await update(tx, artifactId, {
        status: "PENDING_SCAN",
        sha256: verdict.sha256,
        verifiedAt: now,
      });
      if (scan === null || !scan.clean) {
        return toView(
          await update(tx, artifactId, {
            status: "REJECTED",
            rejectionReason: "MALWARE",
            scannedBy: scan?.engine ?? null,
          }),
        );
      }
      return toView(await update(tx, artifactId, { status: "AVAILABLE", scannedBy: scan.engine }));
    });
  }

  /**
   * One artifact, with a short-lived view URL from the storage origin once it
   * is AVAILABLE. Never for anything unverified or rejected: those bytes were
   * not proven to be an image.
   */
  async view(
    artifactId: string,
  ): Promise<{ readonly artifact: PodArtifactView; readonly viewUrl: string | null }> {
    const artifact = await this.database.withTenant((tx) => findArtifact(tx, artifactId));
    return {
      artifact: toView(artifact),
      viewUrl:
        artifact.status === "AVAILABLE" ? this.storage.presignGet(artifact.objectKey).url : null,
    };
  }

  private async verify(
    artifact: PodArtifact,
  ): Promise<
    | { readonly ok: true; readonly bytes: Uint8Array; readonly sha256: string }
    | { readonly ok: false; readonly reason: "SIZE_MISMATCH" | "TYPE_MISMATCH" | "EXIF_PRESENT" }
  > {
    let bytes: Uint8Array | null;
    try {
      const head = await this.storage.head(artifact.objectKey);
      if (head === null) {
        throw notUploaded();
      }
      if (head.sizeBytes !== artifact.sizeBytes) {
        return { ok: false, reason: "SIZE_MISMATCH" };
      }
      bytes = await this.storage.read(artifact.objectKey, MAX_POD_MEDIA_BYTES);
    } catch (error) {
      if (error instanceof DomainError) {
        throw error;
      }
      if (error instanceof ObjectTooLargeError) {
        return { ok: false, reason: "SIZE_MISMATCH" };
      }
      // Timeout, open breaker, 5xx: the store's problem, and retryable.
      throw new DomainError(
        "STORAGE_UNAVAILABLE",
        "Media storage is unavailable; retry shortly",
        503,
      );
    }
    if (bytes === null) {
      throw notUploaded();
    }
    if (bytes.byteLength !== artifact.sizeBytes) {
      return { ok: false, reason: "SIZE_MISMATCH" };
    }
    const inspected = inspectImage(bytes, toContentType(artifact.contentType));
    if (!inspected.ok) {
      return { ok: false, reason: inspected.reason };
    }
    return { ok: true, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function replayOf(
  tx: TenantTransaction,
  key: string,
  actorId: string,
  requestHash: string,
): Promise<PodArtifact | undefined> {
  const prior = (
    await tx.select().from(podArtifacts).where(eq(podArtifacts.idempotencyKey, key)).limit(1)
  )[0];
  if (prior === undefined) {
    return undefined;
  }
  if (prior.uploadedByUserId !== actorId || prior.requestHash !== requestHash) {
    throw idempotencyKeyReused();
  }
  return prior;
}

async function findArtifact(tx: TenantTransaction, id: string): Promise<PodArtifact> {
  const row = (await tx.select().from(podArtifacts).where(eq(podArtifacts.id, id)).limit(1))[0];
  if (row === undefined) {
    throw new NotFoundError("POD media");
  }
  return row;
}

async function update(
  tx: TenantTransaction,
  id: string,
  fields: Partial<
    Pick<PodArtifact, "status" | "rejectionReason" | "sha256" | "scannedBy" | "verifiedAt">
  >,
): Promise<PodArtifact> {
  const row = (
    await tx.update(podArtifacts).set(fields).where(eq(podArtifacts.id, id)).returning()
  )[0];
  if (row === undefined) {
    throw new NotFoundError("POD media");
  }
  return row;
}

function requireActor(): { readonly userId: string; readonly driverId: string | null } {
  const state = TenantContext.current();
  if (state?.actorId === undefined) {
    throw new UnauthenticatedError();
  }
  return { userId: state.actorId, driverId: state.driverId ?? null };
}

function notUploaded(): ConflictError {
  return new ConflictError("MEDIA_NOT_UPLOADED", "Nothing has been uploaded to this slot yet");
}

function toView(row: PodArtifact): PodArtifactView {
  return {
    id: row.id,
    shipmentId: row.shipmentId,
    purpose: toPurpose(row.purpose),
    objectKey: row.objectKey,
    contentType: toContentType(row.contentType),
    sizeBytes: row.sizeBytes,
    status: toStatus(row.status),
    rejectionReason: row.rejectionReason,
    sha256: row.sha256,
    createdAt: row.createdAt,
    verifiedAt: row.verifiedAt,
  };
}

// The CHECK constraints guarantee these values; the guards narrow honestly.

function toPurpose(value: string): PodMediaPurpose {
  if (value === "POD_PHOTO" || value === "POD_SIGNATURE") return value;
  throw new Error(`Unknown POD media purpose: ${value}`);
}

function toContentType(value: string): MediaContentType {
  if (value === "image/jpeg" || value === "image/png") return value;
  throw new Error(`Unknown POD media type: ${value}`);
}

function toStatus(value: string): PodArtifactStatus {
  if (
    value === "PENDING_UPLOAD" ||
    value === "PENDING_SCAN" ||
    value === "AVAILABLE" ||
    value === "REJECTED"
  ) {
    return value;
  }
  throw new Error(`Unknown POD media status: ${value}`);
}
