import { z } from "zod";

/**
 * Validated input contracts for the support module.
 *
 * Strict objects throughout: a merchant portal posts to these, and silently
 * dropping an unknown key is how a client ends up believing it set something it
 * did not.
 */

export const TICKET_STATUSES = ["OPEN", "PENDING_MERCHANT", "RESOLVED", "CLOSED"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_CATEGORIES = [
  "BILLING",
  "PICKUP",
  "DELIVERY",
  "ACCOUNT",
  "TECHNICAL",
  "OTHER",
] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

const nonEmpty = (label: string) => z.string().trim().min(1, `${label} is required`);

export const openTicketSchema = z.strictObject({
  subject: nonEmpty("subject").max(200),
  /** The first message. A ticket with no question is not a ticket. */
  body: nonEmpty("body").max(5000),
  category: z.enum(TICKET_CATEGORIES).optional(),
  /**
   * Whose ticket. Optional because a MERCHANT login has no need to state it —
   * the service reads it from their token, and a merchant naming another
   * merchant would be an attempt to open a ticket on someone else's account.
   */
  merchantId: z.uuid().optional(),
  shipmentId: z.uuid().optional(),
  attachmentKeys: z.array(nonEmpty("key").max(500)).max(10).optional(),
});
export type OpenTicketInput = z.infer<typeof openTicketSchema>;

export const replySchema = z.strictObject({
  body: nonEmpty("body").max(5000),
  /**
   * A staff-only note on the thread.
   *
   * ⚠️ Refused for a merchant caller by the service AND by
   * `support_messages_internal_chk`. A merchant writing an internal note would
   * produce a message invisible to its own author.
   */
  internal: z.boolean().optional(),
  attachmentKeys: z.array(nonEmpty("key").max(500)).max(10).optional(),
});
export type ReplyInput = z.infer<typeof replySchema>;

export const updateTicketSchema = z
  .strictObject({
    status: z.enum(TICKET_STATUSES).optional(),
    category: z.enum(TICKET_CATEGORIES).optional(),
    /** Null hands the ticket back to the unassigned pool. */
    assignedToUserId: z.uuid().nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "at least one field must be provided",
  });
export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;

export const listTicketsSchema = z.strictObject({
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.uuid().optional(),
  status: z.enum(TICKET_STATUSES).optional(),
  category: z.enum(TICKET_CATEGORIES).optional(),
  merchantId: z.uuid().optional(),
  assignedToUserId: z.uuid().optional(),
  /** Everything still needing an answer: OPEN or PENDING_MERCHANT. */
  openOnly: z.boolean().optional(),
});
export type ListTicketsInput = z.infer<typeof listTicketsSchema>;
