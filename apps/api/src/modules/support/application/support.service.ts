import { Injectable } from "@nestjs/common";
import { and, asc, count, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { OutboxService } from "../../platform/index.js";
import { DatabaseService, TenantContext } from "../../../shared/database/index.js";
import type { TenantTransaction } from "../../../shared/database/index.js";
import { BusinessRuleError, NotFoundError, ValidationError } from "../../../shared/errors/index.js";
import { parseWithZod } from "../../../shared/http/index.js";
import {
  listTicketsSchema,
  openTicketSchema,
  replySchema,
  updateTicketSchema,
} from "../domain/dtos.js";
import { supportMessages, supportTickets } from "../domain/schema.js";
import type { SupportMessage, SupportTicket } from "../domain/schema.js";

/** A ticket with its thread, which is the only way anyone reads one. */
export interface TicketView {
  readonly ticket: SupportTicket;
  readonly messages: readonly SupportMessage[];
}

export interface TicketPage {
  readonly items: readonly SupportTicket[];
  readonly nextCursor: string | null;
}

const DEFAULT_PAGE_SIZE = 50;

/** Still needing an answer from somebody. Not the same as "not closed". */
const OPEN_STATUSES = ["OPEN", "PENDING_MERCHANT"] as const;

/**
 * Support — the merchant/back-office conversation.
 *
 * A ticket is a QUESTION; a complaint is a CLAIM. They are separate contexts
 * because merging them means every complaint query has to exclude a type that is
 * not a complaint, and the dashboard's open-complaints figure counts questions.
 *
 * ⚠️ TWO RULES THE DATABASE ENFORCES AND THIS SERVICE ONLY EXPLAINS:
 *
 *  1. A merchant login never reads an INTERNAL message. RLS, not a query filter
 *     — a filter is one forgotten WHERE clause away from showing a merchant what
 *     the back office said about them.
 *  2. A merchant can only ever open a ticket for their OWN merchant. The id
 *     comes from their token; naming another merchant is refused rather than
 *     silently rescoped.
 */
@Injectable()
export class SupportService {
  constructor(
    private readonly database: DatabaseService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Opens a ticket with its first message.
   *
   * @param authorSide MERCHANT when a merchant portal login is asking, COURIER
   *   when staff are opening one on their behalf (a phone call, typically).
   */
  async open(
    input: unknown,
    actorUserId: string,
    authorSide: "MERCHANT" | "COURIER",
  ): Promise<TicketView> {
    const dto = parseWithZod(openTicketSchema, input);

    return this.database.withTenant(async (tx) => {
      const tenantId = TenantContext.requireTenantId();
      const merchantId = this.resolveMerchant(dto.merchantId, authorSide);

      const year = new Date().getUTCFullYear();
      const reference = `S-${String(year)}-${String(await nextTicketNumber(tx, tenantId, year)).padStart(5, "0")}`;

      const inserted = await tx
        .insert(supportTickets)
        .values({
          tenantId,
          reference,
          subject: dto.subject,
          merchantId,
          openedByUserId: actorUserId,
          // A ticket a merchant just opened is waiting on the COURIER, so it is
          // OPEN. PENDING_MERCHANT is set only when staff reply asking for
          // something back.
          status: "OPEN",
          ...(dto.category === undefined ? {} : { category: dto.category }),
          ...(dto.shipmentId === undefined ? {} : { shipmentId: dto.shipmentId }),
        })
        .returning({ id: supportTickets.id });

      const ticketId = requireId(inserted);

      await tx.insert(supportMessages).values({
        tenantId,
        ticketId,
        body: dto.body,
        visibility: "PUBLIC",
        authorUserId: actorUserId,
        authorSide,
        ...(dto.attachmentKeys === undefined ? {} : { attachmentKeys: [...dto.attachmentKeys] }),
      });

      await this.outbox.publish(tx, {
        eventType: "support.ticket_opened",
        aggregateType: "support_ticket",
        aggregateId: ticketId,
        payload: { reference, subject: dto.subject, merchantId, category: dto.category ?? "OTHER" },
      });

      return this.load(tx, ticketId);
    });
  }

  /**
   * Adds a message to the thread.
   *
   * The status moves with the reply, because a support queue whose statuses are
   * set by hand is a support queue whose statuses are wrong: a courier reply
   * puts the ball in the merchant's court (PENDING_MERCHANT), and a merchant
   * reply puts it back (OPEN).
   */
  async reply(
    ticketId: string,
    input: unknown,
    actorUserId: string,
    authorSide: "MERCHANT" | "COURIER",
  ): Promise<TicketView> {
    const dto = parseWithZod(replySchema, input);
    const internal = dto.internal ?? false;

    if (internal && authorSide === "MERCHANT") {
      // Also refused by `support_messages_internal_chk`. Caught here so the
      // caller gets a field error rather than a raw 23514.
      throw new ValidationError(
        [
          {
            field: "internal",
            code: "FORBIDDEN",
            detail: "Only the courier can write an internal note.",
          },
        ],
        "A merchant cannot write an internal note.",
      );
    }

    return this.database.withTenant(async (tx) => {
      const tenantId = TenantContext.requireTenantId();
      const ticket = await this.requireTicket(tx, ticketId);

      if (ticket.status === "CLOSED") {
        throw new BusinessRuleError(
          "TICKET_CLOSED",
          "This ticket is closed; open a new one rather than reviving it.",
        );
      }

      await tx.insert(supportMessages).values({
        tenantId,
        ticketId,
        body: dto.body,
        visibility: internal ? "INTERNAL" : "PUBLIC",
        authorUserId: actorUserId,
        authorSide,
        ...(dto.attachmentKeys === undefined ? {} : { attachmentKeys: [...dto.attachmentKeys] }),
      });

      await tx
        .update(supportTickets)
        .set({
          lastMessageAt: sql`now()`,
          updatedAt: sql`now()`,
          // ⚠️ An INTERNAL note does not move the ticket. Nobody is waiting on a
          // remark the merchant cannot see, and flipping to PENDING_MERCHANT
          // would tell the queue someone had been asked a question they were
          // never sent.
          ...(internal
            ? {}
            : { status: authorSide === "COURIER" ? "PENDING_MERCHANT" : "OPEN" }),
        })
        .where(eq(supportTickets.id, ticketId));

      return this.load(tx, ticketId);
    });
  }

  /** Reassign, recategorise, or move the status by hand. */
  async update(ticketId: string, input: unknown, actorUserId: string): Promise<TicketView> {
    const dto = parseWithZod(updateTicketSchema, input);

    return this.database.withTenant(async (tx) => {
      const ticket = await this.requireTicket(tx, ticketId);

      const closing = dto.status === "CLOSED" && ticket.status !== "CLOSED";
      const reopening = dto.status !== undefined && dto.status !== "CLOSED" && ticket.status === "CLOSED";

      await tx
        .update(supportTickets)
        .set({
          updatedAt: sql`now()`,
          ...(dto.status === undefined ? {} : { status: dto.status }),
          ...(dto.category === undefined ? {} : { category: dto.category }),
          ...(dto.assignedToUserId === undefined
            ? {}
            : { assignedToUserId: dto.assignedToUserId }),
          // `support_tickets_closed_chk` treats the pair as one: a closure with
          // no closer records nothing, and reopening must clear both.
          ...(closing ? { closedAt: sql`now()`, closedByUserId: actorUserId } : {}),
          ...(reopening ? { closedAt: null, closedByUserId: null } : {}),
        })
        .where(eq(supportTickets.id, ticketId));

      return this.load(tx, ticketId);
    });
  }

  async getById(ticketId: string): Promise<TicketView> {
    return this.database.withTenant((tx) => this.load(tx, ticketId));
  }

  async list(input: unknown = {}): Promise<TicketPage> {
    const dto = parseWithZod(listTicketsSchema, input);
    const limit = dto.limit ?? DEFAULT_PAGE_SIZE;

    return this.database.withTenant(async (tx) => {
      const conditions: SQL[] = [
        ...(dto.status === undefined ? [] : [eq(supportTickets.status, dto.status)]),
        ...(dto.openOnly === true ? [inArray(supportTickets.status, [...OPEN_STATUSES])] : []),
        ...(dto.category === undefined ? [] : [eq(supportTickets.category, dto.category)]),
        ...(dto.merchantId === undefined ? [] : [eq(supportTickets.merchantId, dto.merchantId)]),
        ...(dto.assignedToUserId === undefined
          ? []
          : [eq(supportTickets.assignedToUserId, dto.assignedToUserId)]),
        ...(dto.cursor === undefined ? [] : [lt(supportTickets.id, dto.cursor)]),
      ];

      const rows = await tx
        .select()
        .from(supportTickets)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(supportTickets.id))
        .limit(limit + 1);

      if (rows.length > limit) {
        const items = rows.slice(0, limit);
        return { items, nextCursor: items[items.length - 1]?.id ?? null };
      }
      return { items: rows, nextCursor: null };
    });
  }

  /** How many still need an answer, for the sidebar badge. */
  async openCount(): Promise<number> {
    return this.database.withTenant(async (tx) => {
      const rows = await tx
        .select({ open: count() })
        .from(supportTickets)
        .where(inArray(supportTickets.status, [...OPEN_STATUSES]));
      return Number(rows[0]?.open ?? 0);
    });
  }

  /**
   * Whose ticket this is.
   *
   * A MERCHANT login's own merchant, always — naming another is refused rather
   * than silently rescoped, because a client that believed it opened a ticket
   * for someone else should be told it did not.
   */
  private resolveMerchant(
    requested: string | undefined,
    authorSide: "MERCHANT" | "COURIER",
  ): string {
    const own = TenantContext.current()?.merchantId;

    if (authorSide === "MERCHANT") {
      if (own === undefined) {
        throw new BusinessRuleError(
          "MERCHANT_SCOPE_REQUIRED",
          "A merchant login must carry a merchant scope.",
        );
      }
      if (requested !== undefined && requested !== own) {
        throw new ValidationError(
          [
            {
              field: "merchantId",
              code: "FORBIDDEN",
              detail: "A merchant can only open a ticket for themselves.",
            },
          ],
          "Cannot open a ticket for another merchant.",
        );
      }
      return own;
    }

    if (requested === undefined) {
      throw new ValidationError(
        [{ field: "merchantId", code: "REQUIRED", detail: "Name the merchant this is about." }],
        "merchantId is required when staff open a ticket.",
      );
    }
    return requested;
  }

  private async requireTicket(tx: TenantTransaction, id: string): Promise<SupportTicket> {
    const rows = await tx.select().from(supportTickets).where(eq(supportTickets.id, id)).limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundError("Support ticket");
    }
    return row;
  }

  /**
   * A ticket with its thread, oldest message first.
   *
   * The message rows are filtered by RLS, not by this query — a merchant simply
   * receives fewer rows, and this code never learns which were withheld.
   */
  private async load(tx: TenantTransaction, id: string): Promise<TicketView> {
    const ticket = await this.requireTicket(tx, id);
    const messages = await tx
      .select()
      .from(supportMessages)
      .where(eq(supportMessages.ticketId, id))
      .orderBy(asc(supportMessages.createdAt), asc(supportMessages.id));
    return { ticket, messages };
  }
}

/**
 * The next reference for a tenant-year, from a ROW-LOCKED counter.
 *
 * Same shape as `invoice_sequences` (0032). A gap here is not a legal problem —
 * nobody audits support tickets — so a sequence would technically do; it is not
 * used because two different mechanisms for "the next human-readable number" in
 * one schema is how the wrong one eventually gets the locking wrong.
 */
async function nextTicketNumber(
  tx: TenantTransaction,
  tenantId: string,
  year: number,
): Promise<number> {
  await tx.execute(sql`
    insert into support_ticket_sequences (tenant_id, year, last_number)
    values (${tenantId}, ${year}, 0)
    on conflict (tenant_id, year) do nothing
  `);

  const locked = await tx.execute<{ last_number: number }>(sql`
    select last_number from support_ticket_sequences
     where tenant_id = ${tenantId} and year = ${year}
       for update
  `);

  const next = Number(locked[0]?.last_number ?? 0) + 1;

  await tx.execute(sql`
    update support_ticket_sequences set last_number = ${next}
     where tenant_id = ${tenantId} and year = ${year}
  `);

  return next;
}

function requireId(rows: readonly { id: string }[]): string {
  const row = rows[0];
  if (row === undefined) {
    throw new Error("Support ticket insert returned no row");
  }
  return row.id;
}

