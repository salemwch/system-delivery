import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { z } from "zod";

import { zodBody } from "../../../shared/http/index.js";
import { CurrentPrincipal, RequirePermissions } from "../../identity/index.js";
import type { Principal } from "../../identity/index.js";
import { ComplaintService } from "../application/complaint.service.js";
import type { ComplaintActor } from "../application/complaint.service.js";
import {
  assignComplaintSchema,
  commentComplaintSchema,
  createComplaintSchema,
  setSlaPolicySchema,
  transitionComplaintSchema,
} from "../domain/dtos.js";
import type { Complaint, ComplaintActivityRow } from "../domain/schema.js";

/**
 * Complaints / réclamations (docs/02-domain-model.md §3.20).
 *
 * Note what is NOT here: no DELETE, on any route. A complaint is never deleted
 * (rule 7) — closing it is a status transition with a recorded outcome, and the
 * activity trail behind it is append-only.
 */

interface ComplaintResponse {
  readonly id: string;
  readonly code: string;
  readonly type: string;
  readonly status: string;
  readonly severity: string;
  readonly shipmentId: string | null;
  readonly merchantId: string | null;
  readonly recipientId: string | null;
  readonly driverId: string | null;
  readonly raisedByType: string;
  readonly description: string;
  readonly attachmentKeys: readonly string[];
  readonly assignedToUserId: string | null;
  readonly slaDueAt: string | null;
  /** Whether the promise has already been missed. Computed, not stored. */
  readonly slaBreached: boolean;
  readonly resolution: string | null;
  readonly resolvedAt: string | null;
  readonly codReversed: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ActivityResponse {
  readonly id: string;
  readonly kind: string;
  readonly fromStatus: string | null;
  readonly toStatus: string | null;
  readonly note: string | null;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly createdAt: string;
}

interface PageResponse<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

@Controller("v1/complaints")
export class ComplaintController {
  constructor(private readonly complaints: ComplaintService) {}

  @Post()
  @RequirePermissions("complaint:create")
  async create(
    @Body(zodBody(createComplaintSchema)) body: z.infer<typeof createComplaintSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ComplaintResponse> {
    return toResponse(await this.complaints.create(body, actorOf(principal)));
  }

  @Get()
  @RequirePermissions("complaint:read")
  async list(@Query() query: unknown): Promise<PageResponse<ComplaintResponse>> {
    const page = await this.complaints.list(query);
    return {
      data: page.items.map(toResponse),
      page: { nextCursor: page.nextCursor, hasMore: page.nextCursor !== null },
    };
  }

  @Get(":id")
  @RequirePermissions("complaint:read")
  async getById(
    @Param("id") id: string,
  ): Promise<ComplaintResponse & { activity: readonly ActivityResponse[] }> {
    const detail = await this.complaints.getById(id);
    return {
      ...toResponse(detail.complaint),
      activity: detail.activity.map(toActivityResponse),
    };
  }

  /**
   * Moves a complaint through its lifecycle, including closing it.
   *
   * `complaint:resolve` rather than `complaint:assign`: deciding the outcome of a
   * claim — and, for a COD dispute, moving money — is a different authority from
   * routing it to someone. FINANCE holds it; DISPATCHER does not.
   */
  @Post(":id/transition")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("complaint:resolve")
  async transition(
    @Param("id") id: string,
    @Body(zodBody(transitionComplaintSchema)) body: z.infer<typeof transitionComplaintSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ComplaintResponse> {
    return toResponse(await this.complaints.transition(id, body, actorOf(principal)));
  }

  @Post(":id/assign")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("complaint:assign")
  async assign(
    @Param("id") id: string,
    @Body(zodBody(assignComplaintSchema)) body: z.infer<typeof assignComplaintSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ComplaintResponse> {
    return toResponse(await this.complaints.assign(id, body, actorOf(principal)));
  }

  /** Adds a comment. Comments are entries — the description is never edited. */
  @Post(":id/comments")
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions("complaint:read")
  async comment(
    @Param("id") id: string,
    @Body(zodBody(commentComplaintSchema)) body: z.infer<typeof commentComplaintSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ added: true }> {
    await this.complaints.comment(id, body, actorOf(principal));
    return { added: true };
  }

  /**
   * Sets the SLA hours for a complaint type. Config as data (rule 6).
   *
   * `feature:manage`, held by OWNER: an SLA is a commercial promise, and someone
   * who can resolve complaints should not also be able to move the deadline they
   * are judged against.
   */
  @Put("sla-policies")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("feature:manage")
  async setSlaPolicy(
    @Body(zodBody(setSlaPolicySchema)) body: z.infer<typeof setSlaPolicySchema>,
  ): Promise<{ updated: true }> {
    await this.complaints.setSlaPolicy(body);
    return { updated: true };
  }
}

/**
 * Maps the authenticated caller onto the complaint actor vocabulary.
 *
 * A MERCHANT raising a complaint is recorded as MERCHANT, not STAFF — the
 * activity trail must say who actually said what when the case is reviewed.
 */
function actorOf(principal: Principal): ComplaintActor {
  return {
    userId: principal.userId,
    actorType: principal.merchantId === null ? "STAFF" : "MERCHANT",
  };
}

function toResponse(complaint: Complaint): ComplaintResponse {
  const closed = complaint.status === "RESOLVED" || complaint.status === "REJECTED";
  return {
    id: complaint.id,
    code: complaint.code,
    type: complaint.type,
    status: complaint.status,
    severity: complaint.severity,
    shipmentId: complaint.shipmentId,
    merchantId: complaint.merchantId,
    recipientId: complaint.recipientId,
    driverId: complaint.driverId,
    raisedByType: complaint.raisedByType,
    description: complaint.description,
    attachmentKeys: complaint.attachmentKeys,
    assignedToUserId: complaint.assignedToUserId,
    slaDueAt: complaint.slaDueAt?.toISOString() ?? null,
    // A closed complaint is judged against when it was closed, not against now —
    // otherwise every historical case drifts into "breached" as time passes.
    slaBreached:
      complaint.slaDueAt !== null &&
      (closed
        ? (complaint.resolvedAt?.getTime() ?? 0) > complaint.slaDueAt.getTime()
        : Date.now() > complaint.slaDueAt.getTime()),
    resolution: complaint.resolution,
    resolvedAt: complaint.resolvedAt?.toISOString() ?? null,
    codReversed: complaint.reversalTransactionId !== null,
    createdAt: complaint.createdAt.toISOString(),
    updatedAt: complaint.updatedAt.toISOString(),
  };
}

function toActivityResponse(row: ComplaintActivityRow): ActivityResponse {
  return {
    id: row.id,
    kind: row.kind,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    note: row.note,
    actorType: row.actorType,
    actorId: row.actorId,
    createdAt: row.createdAt.toISOString(),
  };
}
