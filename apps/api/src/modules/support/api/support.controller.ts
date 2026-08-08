import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from "@nestjs/common";
import { z } from "zod";

import { TenantContext } from "../../../shared/database/index.js";
import { zodBody } from "../../../shared/http/index.js";
import { CurrentPrincipal, RequirePermissions } from "../../identity/index.js";
import type { Principal } from "../../identity/index.js";
import { SupportService } from "../application/support.service.js";
import type { TicketView } from "../application/support.service.js";
import {
  TICKET_CATEGORIES,
  TICKET_STATUSES,
  openTicketSchema,
  replySchema,
  updateTicketSchema,
} from "../domain/dtos.js";
import type { SupportMessage, SupportTicket } from "../domain/schema.js";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
  status: z.enum(TICKET_STATUSES).optional(),
  category: z.enum(TICKET_CATEGORIES).optional(),
  merchantId: z.string().min(1).optional(),
  assignedToUserId: z.string().min(1).optional(),
  openOnly: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

interface MessageResponse {
  readonly id: string;
  readonly body: string;
  /** PUBLIC | INTERNAL. A merchant never receives an INTERNAL row at all. */
  readonly visibility: string;
  readonly authorUserId: string;
  readonly authorSide: string;
  readonly attachmentKeys: readonly string[];
  readonly createdAt: string;
}

interface TicketResponse {
  readonly id: string;
  readonly reference: string;
  readonly subject: string;
  readonly status: string;
  readonly category: string;
  readonly merchantId: string;
  readonly shipmentId: string | null;
  readonly openedByUserId: string;
  readonly assignedToUserId: string | null;
  readonly lastMessageAt: string;
  readonly closedAt: string | null;
  readonly createdAt: string;
}

interface TicketDetailResponse extends TicketResponse {
  readonly messages: readonly MessageResponse[];
}

interface PageResponse<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

/**
 * Support.
 *
 * Both sides use these routes. What differs is what comes back: RLS narrows a
 * merchant login to their own tickets and strips every INTERNAL message, so the
 * same handler serves both without a single branch on role.
 */
@Controller("v1/support-tickets")
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Post()
  @RequirePermissions("support:write")
  @HttpCode(HttpStatus.CREATED)
  async open(
    @Body(zodBody(openTicketSchema)) body: z.infer<typeof openTicketSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<TicketDetailResponse> {
    return toDetail(await this.support.open(body, principal.userId, sideOf()));
  }

  @Get()
  @RequirePermissions("support:read")
  async list(@Query() query: unknown): Promise<PageResponse<TicketResponse>> {
    const parsed = listQuerySchema.parse(query);
    const page = await this.support.list({
      ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
      ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
      ...(parsed.status === undefined ? {} : { status: parsed.status }),
      ...(parsed.category === undefined ? {} : { category: parsed.category }),
      ...(parsed.merchantId === undefined ? {} : { merchantId: parsed.merchantId }),
      ...(parsed.assignedToUserId === undefined
        ? {}
        : { assignedToUserId: parsed.assignedToUserId }),
      ...(parsed.openOnly === undefined ? {} : { openOnly: parsed.openOnly }),
    });
    return {
      data: page.items.map(toTicket),
      page: { nextCursor: page.nextCursor, hasMore: page.nextCursor !== null },
    };
  }

  /** How many need an answer. Declared before `:id`, which would match "count". */
  @Get("count")
  @RequirePermissions("support:read")
  async count(): Promise<{ readonly open: number }> {
    return { open: await this.support.openCount() };
  }

  @Get(":id")
  @RequirePermissions("support:read")
  async getById(@Param("id") id: string): Promise<TicketDetailResponse> {
    return toDetail(await this.support.getById(id));
  }

  @Post(":id/messages")
  @RequirePermissions("support:write")
  @HttpCode(HttpStatus.CREATED)
  async reply(
    @Param("id") id: string,
    @Body(zodBody(replySchema)) body: z.infer<typeof replySchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<TicketDetailResponse> {
    return toDetail(await this.support.reply(id, body, principal.userId, sideOf()));
  }

  /** Assign, recategorise, close. Staff only — a merchant holds no `support:manage`. */
  @Patch(":id")
  @RequirePermissions("support:manage")
  async update(
    @Param("id") id: string,
    @Body(zodBody(updateTicketSchema)) body: z.infer<typeof updateTicketSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<TicketDetailResponse> {
    return toDetail(await this.support.update(id, body, principal.userId));
  }
}

/**
 * Which side of the conversation the caller is on.
 *
 * ⚠️ Derived from the TENANT CONTEXT's merchant scope, not from a role list and
 * never from the request body. A caller carrying `app.current_merchant_id` is a
 * merchant login by construction (invariant I24) — that is the same fact RLS
 * uses to hide internal notes from them, so the two can never disagree.
 */
function sideOf(): "MERCHANT" | "COURIER" {
  return TenantContext.current()?.merchantId === undefined ? "COURIER" : "MERCHANT";
}

function toTicket(ticket: SupportTicket): TicketResponse {
  return {
    id: ticket.id,
    reference: ticket.reference,
    subject: ticket.subject,
    status: ticket.status,
    category: ticket.category,
    merchantId: ticket.merchantId,
    shipmentId: ticket.shipmentId,
    openedByUserId: ticket.openedByUserId,
    assignedToUserId: ticket.assignedToUserId,
    lastMessageAt: ticket.lastMessageAt.toISOString(),
    closedAt: ticket.closedAt?.toISOString() ?? null,
    createdAt: ticket.createdAt.toISOString(),
  };
}

function toDetail(view: TicketView): TicketDetailResponse {
  return { ...toTicket(view.ticket), messages: view.messages.map(toMessage) };
}

function toMessage(message: SupportMessage): MessageResponse {
  return {
    id: message.id,
    body: message.body,
    visibility: message.visibility,
    authorUserId: message.authorUserId,
    authorSide: message.authorSide,
    attachmentKeys: message.attachmentKeys,
    createdAt: message.createdAt.toISOString(),
  };
}
