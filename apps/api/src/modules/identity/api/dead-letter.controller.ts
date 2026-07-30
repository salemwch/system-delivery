import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";

import { zodBody } from "../../../shared/http/index.js";
import { DeadLetterService } from "../../platform/index.js";
import type { DeadLetterEvent } from "../../platform/index.js";
import { RequirePermissions } from "./request-context.js";

/**
 * The dead-letter admin path.
 *
 * Lives in `identity` rather than `platform` for the same reason the audit
 * controller does: `platform` is layer 0 and cannot import the permission
 * decorators. The service stays in platform, where every module can reach it.
 *
 * Guarded by `feature:manage` — replaying an event re-runs a handler that may
 * post to the ledger or send a customer an SMS, and discarding one accepts a
 * permanent gap. Neither is a dispatcher-level authority.
 */

const resolveSchema = z.strictObject({
  note: z.string().trim().min(1, "note is required").max(1000),
});

const discardSchema = z.strictObject({
  reason: z.string().trim().min(1, "reason is required").max(1000),
});

interface DeadLetterResponse {
  readonly id: string;
  readonly consumerGroup: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly status: string;
  readonly error: string;
  readonly deliveryCount: number;
  readonly payload: unknown;
  readonly firstFailedAt: string;
  readonly lastFailedAt: string;
  readonly resolvedAt: string | null;
}

interface PageResponse<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

@Controller("v1/dead-letters")
export class DeadLetterController {
  constructor(private readonly deadLetters: DeadLetterService) {}

  @Get()
  @RequirePermissions("feature:manage")
  async list(@Query() query: unknown): Promise<PageResponse<DeadLetterResponse>> {
    const page = await this.deadLetters.list(query);
    return {
      data: page.items.map(toResponse),
      page: { nextCursor: page.nextCursor, hasMore: page.nextCursor !== null },
    };
  }

  /** How many are waiting per consumer group — the number an ops dashboard shows. */
  @Get("pending-counts")
  @RequirePermissions("feature:manage")
  async pendingCounts(): Promise<{
    data: readonly { consumerGroup: string; count: number }[];
  }> {
    return { data: await this.deadLetters.pendingCounts() };
  }

  @Get(":id")
  @RequirePermissions("feature:manage")
  async getById(@Param("id") id: string): Promise<DeadLetterResponse> {
    return toResponse(await this.deadLetters.getById(id));
  }

  /**
   * Re-runs the handler.
   *
   * Returns 200 with `replayed: false` when the handler fails again, rather than
   * a 5xx: the request itself succeeded, and the operator needs the handler's
   * error message to decide what to do next. A 500 would hide it behind a
   * generic problem document.
   */
  @Post(":id/replay")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("feature:manage")
  async replay(@Param("id") id: string): Promise<{ replayed: boolean; error: string | null }> {
    return this.deadLetters.replay(id);
  }

  /** Marks it handled WITHOUT re-running — the effect was achieved another way. */
  @Post(":id/resolve")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("feature:manage")
  async resolve(
    @Param("id") id: string,
    @Body(zodBody(resolveSchema)) body: z.infer<typeof resolveSchema>,
  ): Promise<{ resolved: true }> {
    await this.deadLetters.resolve(id, body.note);
    return { resolved: true };
  }

  /** Accepts that it will never be processed. The reason is mandatory. */
  @Post(":id/discard")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("feature:manage")
  async discard(
    @Param("id") id: string,
    @Body(zodBody(discardSchema)) body: z.infer<typeof discardSchema>,
  ): Promise<{ discarded: true }> {
    await this.deadLetters.discard(id, body);
    return { discarded: true };
  }
}

function toResponse(row: DeadLetterEvent): DeadLetterResponse {
  return {
    id: row.id,
    consumerGroup: row.consumerGroup,
    eventId: row.eventId,
    eventType: row.eventType,
    status: row.status,
    error: row.error,
    deliveryCount: row.deliveryCount,
    payload: row.payload,
    firstFailedAt: row.firstFailedAt.toISOString(),
    lastFailedAt: row.lastFailedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  };
}
