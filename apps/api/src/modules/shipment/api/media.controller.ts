import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import type { z } from "zod";

import { zodBody } from "../../../shared/http/index.js";
import { RequirePermissions } from "../../identity/index.js";
import { PodMediaService } from "../application/pod-media.service.js";
import type { PodArtifactView } from "../application/pod-media.service.js";
import { presignMediaSchema } from "../domain/dtos.js";

interface ArtifactResponse {
  readonly id: string;
  readonly shipmentId: string;
  readonly purpose: string;
  readonly objectKey: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly status: string;
  readonly rejectionReason: string | null;
  readonly sha256: string | null;
  readonly createdAt: string;
  readonly verifiedAt: string | null;
}

interface PresignResponse extends ArtifactResponse {
  /** Null once the slot is no longer waiting for its upload. */
  readonly uploadUrl: string | null;
  readonly expiresIn: number | null;
  /** Send these verbatim with the PUT: they are part of the signature. */
  readonly requiredHeaders: Readonly<Record<string, string>> | null;
}

/**
 * POD media (docs/05-api-contracts.md §8, docs/07 §7.1).
 *
 * Upload is the driver's (`shipment:deliver`); RLS decides which parcels they
 * may attach media to. Viewing is `shipment:read`, narrowed by the same RLS
 * as the shipment itself, so a merchant sees the proof for their own parcels
 * and nobody else's.
 */
@Controller("v1/media")
export class MediaController {
  constructor(private readonly media: PodMediaService) {}

  /**
   * `201` with a slot and its upload URL. A replayed idempotency key returns
   * the same slot, with a fresh URL if it is still waiting, and
   * `Idempotency-Replayed: true`.
   */
  @Post("presign")
  @RequirePermissions("shipment:deliver")
  async presign(
    @Body(zodBody(presignMediaSchema)) body: z.infer<typeof presignMediaSchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<PresignResponse> {
    const outcome = await this.media.presign(body);
    if (outcome.replayed) {
      void reply.header("Idempotency-Replayed", "true");
    }
    return {
      ...toResponse(outcome.artifact),
      uploadUrl: outcome.upload?.url ?? null,
      expiresIn: outcome.upload?.expiresInSeconds ?? null,
      requiredHeaders: outcome.upload?.headers ?? null,
    };
  }

  /** Verifies the uploaded bytes. `409 MEDIA_NOT_UPLOADED` until they exist. */
  @Post(":id/complete")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("shipment:deliver")
  async complete(@Param("id") id: string): Promise<ArtifactResponse> {
    return toResponse(await this.media.complete(id));
  }

  /** The artifact, and a five-minute view URL once it is AVAILABLE. */
  @Get(":id")
  @RequirePermissions("shipment:read")
  async view(
    @Param("id") id: string,
  ): Promise<ArtifactResponse & { readonly viewUrl: string | null }> {
    const { artifact, viewUrl } = await this.media.view(id);
    return { ...toResponse(artifact), viewUrl };
  }
}

function toResponse(a: PodArtifactView): ArtifactResponse {
  return {
    id: a.id,
    shipmentId: a.shipmentId,
    purpose: a.purpose,
    objectKey: a.objectKey,
    contentType: a.contentType,
    sizeBytes: a.sizeBytes,
    status: a.status,
    rejectionReason: a.rejectionReason,
    sha256: a.sha256,
    createdAt: a.createdAt.toISOString(),
    verifiedAt: a.verifiedAt?.toISOString() ?? null,
  };
}
