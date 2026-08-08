/**
 * Support context public API.
 *
 * The merchant/back-office conversation: a ticket is a QUESTION, where a
 * complaint is a CLAIM. Never merged with `complaint`.
 */
export { SupportModule } from "./support.module.js";
export { SupportService } from "./application/support.service.js";
export type { TicketView, TicketPage } from "./application/support.service.js";

export { supportTickets, supportMessages, supportTicketSequences } from "./domain/schema.js";
export type {
  SupportTicket,
  NewSupportTicket,
  SupportMessage,
  NewSupportMessage,
} from "./domain/schema.js";

export { TICKET_STATUSES, TICKET_CATEGORIES } from "./domain/dtos.js";
export type {
  TicketStatus,
  TicketCategory,
  OpenTicketInput,
  ReplyInput,
  UpdateTicketInput,
  ListTicketsInput,
} from "./domain/dtos.js";
