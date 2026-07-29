import { Controller, Get, Query } from "@nestjs/common";

import { RequirePermissions } from "./request-context.js";
import { AuditService } from "../../platform/index.js";
import type { AuditEntry } from "../../platform/index.js";

/**
 * Reading the audit trail (docs/07-security-architecture.md §10).
 *
 * Read-only by construction — there is no write endpoint, and there never will
 * be one. Entries are appended by the services that perform the actions, inside
 * the same transaction, so the trail cannot be composed by hand.
 *
 * `audit:read` is held by OWNER, FINANCE and PLATFORM_ADMIN only. Notably NOT
 * by DISPATCHER, the most numerous and least-hardened account type, and not by
 * MERCHANT, who is not a member of the tenant at all.
 */

interface AuditEntryResponse {
  readonly id: string;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly actorLabel: string | null;
  readonly action: string;
  readonly outcome: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly changes: unknown;
  readonly context: unknown;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly correlationId: string | null;
  readonly createdAt: string;
}

interface PageResponse<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

@Controller("v1/audit")
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermissions("audit:read")
  async list(@Query() query: unknown): Promise<PageResponse<AuditEntryResponse>> {
    const page = await this.audit.query(query);
    return {
      data: page.items.map(toResponse),
      page: { nextCursor: page.nextCursor, hasMore: page.nextCursor !== null },
    };
  }
}

function toResponse(entry: AuditEntry): AuditEntryResponse {
  return {
    id: entry.id,
    actorType: entry.actorType,
    actorId: entry.actorId,
    actorLabel: entry.actorLabel,
    action: entry.action,
    outcome: entry.outcome,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    changes: entry.changes,
    context: entry.context,
    ipAddress: entry.ipAddress,
    userAgent: entry.userAgent,
    correlationId: entry.correlationId,
    createdAt: entry.createdAt.toISOString(),
  };
}
