/**
 * The notification provider port (docs/04-context-map.md §3.11, ADR — MVP-O1).
 *
 * SMS provider selection and Tunisian sender-ID registration are handled
 * separately (CLAUDE.md scope §4) and must never block development — so only this
 * ABSTRACTION exists in the codebase. The `logging` implementation writes the
 * message to the structured log instead of sending it, which lets the entire
 * notification pipeline run and be tested without a real aggregator. When MVP-O1
 * resolves, a Twilio/aggregator provider implements this same port behind an
 * Anti-Corruption Layer — no caller changes.
 */

export type NotificationChannel = "SMS" | "PUSH" | "EMAIL";

export interface OutboundMessage {
  /** The resolved recipient — a phone number (SMS) or device token (PUSH). */
  readonly to: string;
  readonly body: string;
  readonly channel: NotificationChannel;
  /** Registered sender id / short code, when the provider requires one. */
  readonly senderId?: string;
}

export interface DeliveryReceipt {
  /** The provider's message handle, for later status reconciliation. */
  readonly providerMessageId: string;
  /** Whether the provider ACCEPTED the message (not proof of final delivery). */
  readonly accepted: boolean;
}

export interface NotificationProvider {
  /** Stable identifier recorded on every notification_log row (e.g. "logging"). */
  readonly name: string;
  /**
   * Hands the message to the transport. Rejects on a provider failure so the
   * caller records FAILED and the consumer can retry — a provider outage must
   * never block the delivery it describes (§3.11).
   */
  send(message: OutboundMessage): Promise<DeliveryReceipt>;
}

/** DI token for the active {@link NotificationProvider}. */
export const NOTIFICATION_PROVIDER = Symbol("NOTIFICATION_PROVIDER");
