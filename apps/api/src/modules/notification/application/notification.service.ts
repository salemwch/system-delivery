import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";

import { FeatureService } from "../../platform/index.js";
import { DatabaseService, asTenantId } from "../../../shared/database/index.js";
import type { TenantTransaction } from "../../../shared/database/index.js";
import { NOTIFICATION_PROVIDER } from "../domain/notification-provider.js";
import type { NotificationChannel, NotificationProvider } from "../domain/notification-provider.js";
import { defaultTemplateBody, renderTemplate } from "../domain/templates.js";
import type { Locale } from "../domain/templates.js";
import { notificationLog, notificationTemplates } from "../domain/schema.js";
import type { NotificationLogRow } from "../domain/schema.js";

/** A request to notify one recipient — assembled by the event handler. */
export interface SendCommand {
  readonly tenantId: string;
  readonly channel: NotificationChannel;
  readonly templateKey: string;
  readonly locale: Locale;
  readonly recipient: string;
  readonly params: Readonly<Record<string, unknown>>;
  /** The triggering event, if any — the idempotency key for the send. */
  readonly eventId?: string;
  readonly correlationId?: string;
}

/**
 * Notification service (docs/04-context-map.md §3.11) — Layer 3.
 *
 * Purely reactive: the event handler calls `send`, which renders a per-tenant,
 * per-locale template and hands it to the provider port. Every decision is
 * recorded in `notification_log` — SENT, FAILED, or SKIPPED — so "did we message
 * this customer, and why not?" is always answerable.
 *
 * Gating: SMS is a real cost in Tunisia and is gated per tenant by `SMS_ENABLED`
 * (fail-closed). A disabled tenant produces a SKIPPED row, never a send. The
 * message is composed and logged inside the tenant's RLS scope; the external
 * provider call is made OUTSIDE the transaction so a slow provider never holds a
 * row lock.
 */
@Injectable()
export class NotificationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly features: FeatureService,
    @Inject(NOTIFICATION_PROVIDER) private readonly provider: NotificationProvider,
  ) {}

  async send(command: SendCommand): Promise<NotificationLogRow> {
    const tenantId = asTenantId(command.tenantId);

    // SMS cost gate (fail-closed). PUSH/EMAIL are not gated by SMS_ENABLED.
    if (command.channel === "SMS" && !(await this.features.isEnabled(tenantId, "SMS_ENABLED"))) {
      return this.record(command, {
        status: "SKIPPED",
        error: "SMS_ENABLED is off for this tenant",
      });
    }

    const body = await this.resolveBody(command);
    if (body === null) {
      return this.record(command, {
        status: "SKIPPED",
        error: `no template for "${command.templateKey}" (${command.locale}/${command.channel})`,
      });
    }

    // Insert PENDING first (idempotent on the triggering event). If the row
    // already exists, this send already happened — return it, send nothing.
    const pending = await this.record(command, { status: "PENDING", body });
    if (pending.status !== "PENDING") {
      return pending;
    }

    try {
      const receipt = await this.provider.send({
        to: command.recipient,
        body,
        channel: command.channel,
      });
      return this.finalise(tenantId, pending.id, {
        status: "SENT",
        providerMessageId: receipt.providerMessageId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Re-throw AFTER recording FAILED, so the consumer retries and the DLQ path
      // engages — a provider outage must not silently swallow the notification.
      await this.finalise(tenantId, pending.id, {
        status: "FAILED",
        error: message.slice(0, 1000),
      });
      throw error;
    }
  }

  private async resolveBody(command: SendCommand): Promise<string | null> {
    const tenantId = asTenantId(command.tenantId);
    const template = await this.database.withTenant(async (tx) => {
      const rows = await tx
        .select({ body: notificationTemplates.body })
        .from(notificationTemplates)
        .where(
          and(
            eq(notificationTemplates.key, command.templateKey),
            eq(notificationTemplates.locale, command.locale),
            eq(notificationTemplates.channel, command.channel),
            eq(notificationTemplates.active, true),
          ),
        )
        .limit(1);
      return rows[0]?.body;
    }, tenantId);

    const body = template ?? defaultTemplateBody(command.templateKey, command.locale);
    return body === undefined ? null : renderTemplate(body, command.params);
  }

  /**
   * Inserts (or returns the existing) log row for this send. Idempotent on
   * (tenant, event, template, channel): a redelivered event does not double-send.
   */
  private async record(
    command: SendCommand,
    extra: { status: string; body?: string; error?: string },
  ): Promise<NotificationLogRow> {
    const tenantId = asTenantId(command.tenantId);
    return this.database.withTenant(async (tx) => {
      const inserted = await tx
        .insert(notificationLog)
        .values({
          tenantId: command.tenantId,
          channel: command.channel,
          templateKey: command.templateKey,
          locale: command.locale,
          recipient: command.recipient,
          provider: this.provider.name,
          status: extra.status,
          params: command.params,
          ...(command.eventId === undefined ? {} : { eventId: command.eventId }),
          ...(command.correlationId === undefined ? {} : { correlationId: command.correlationId }),
          ...(extra.body === undefined ? {} : { body: extra.body }),
          ...(extra.error === undefined ? {} : { error: extra.error }),
        })
        .onConflictDoNothing({
          target: [
            notificationLog.tenantId,
            notificationLog.eventId,
            notificationLog.templateKey,
            notificationLog.channel,
          ],
        })
        .returning();
      const row = inserted[0];
      if (row !== undefined) {
        return row;
      }
      // Conflict — the send already exists for this event. Return the prior row.
      return this.requireExisting(tx, command);
    }, tenantId);
  }

  private async requireExisting(
    tx: TenantTransaction,
    command: SendCommand,
  ): Promise<NotificationLogRow> {
    if (command.eventId === undefined) {
      throw new Error("notification insert returned no row without an eventId conflict key");
    }
    const rows = await tx
      .select()
      .from(notificationLog)
      .where(
        and(
          eq(notificationLog.eventId, command.eventId),
          eq(notificationLog.templateKey, command.templateKey),
          eq(notificationLog.channel, command.channel),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new Error("notification conflict but no existing row found");
    }
    return row;
  }

  private async finalise(
    tenantId: ReturnType<typeof asTenantId>,
    id: string,
    outcome: { status: "SENT" | "FAILED"; providerMessageId?: string; error?: string },
  ): Promise<NotificationLogRow> {
    return this.database.withTenant(async (tx) => {
      const rows = await tx
        .update(notificationLog)
        .set({
          status: outcome.status,
          ...(outcome.status === "SENT" ? { sentAt: new Date() } : {}),
          ...(outcome.providerMessageId === undefined
            ? {}
            : { providerMessageId: outcome.providerMessageId }),
          ...(outcome.error === undefined ? {} : { error: outcome.error }),
        })
        .where(eq(notificationLog.id, id))
        .returning();
      const row = rows[0];
      if (row === undefined) {
        throw new Error("notification_log row vanished during finalise");
      }
      return row;
    }, tenantId);
  }
}
