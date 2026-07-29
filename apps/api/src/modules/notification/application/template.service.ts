import { Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { DatabaseService, TenantContext } from "../../../shared/database/index.js";
import { parseWithZod } from "../../../shared/http/index.js";
import {
  DEFAULT_TEMPLATES,
  NOTIFICATION_LOCALES,
  estimateSegments,
  renderTemplate,
} from "../domain/templates.js";
import type { Locale } from "../domain/templates.js";
import { notificationTemplates } from "../domain/schema.js";

/**
 * The tokens a template may reference.
 *
 * Derived from the built-in defaults, so a tenant cannot introduce a placeholder
 * no event will ever populate. Without this an operator writes
 * `{{customerName}}`, it renders empty forever, and nobody notices until a
 * customer asks why the message begins with a comma.
 */
const KNOWN_TOKENS: ReadonlySet<string> = new Set(
  Object.values(DEFAULT_TEMPLATES)
    .flatMap((byLocale) => Object.values(byLocale))
    .flatMap((body) => [...body.matchAll(/\{\{\s*(\w+)\s*\}\}/gu)].map((m) => m[1] ?? "")),
);

const upsertTemplateSchema = z
  .strictObject({
    /** The event type this template renders, e.g. `shipment.delivered`. */
    key: z.string().trim().min(1).max(128),
    locale: z.enum(NOTIFICATION_LOCALES),
    channel: z.enum(["SMS", "PUSH", "EMAIL"]),
    /**
     * 1000 characters is roughly six UCS-2 segments. Beyond that an operator has
     * almost certainly pasted something by mistake.
     */
    body: z.string().trim().min(1).max(1000),
    active: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const unknown = [...value.body.matchAll(/\{\{\s*(\w+)\s*\}\}/gu)]
      .map((match) => match[1] ?? "")
      .filter((token) => !KNOWN_TOKENS.has(token));

    if (unknown.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["body"],
        message: `unknown placeholder(s): ${unknown.join(", ")}. Available: ${[...KNOWN_TOKENS].sort().join(", ")}`,
      });
    }
  });

const previewSchema = z.strictObject({
  key: z.string().trim().min(1).max(128),
  locale: z.enum(NOTIFICATION_LOCALES),
  channel: z.enum(["SMS", "PUSH", "EMAIL"]),
});

export interface TemplateView {
  readonly key: string;
  readonly locale: Locale;
  readonly channel: string;
  readonly body: string;
  readonly active: boolean;
  /** True when this is the built-in default rather than a tenant override. */
  readonly isDefault: boolean;
  /**
   * How many SMS segments the body costs. Surfaced because Arabic is UCS-2 at 70
   * characters per segment, so a natural-reading Arabic template is easily three
   * segments — a real line item at volume, and invisible without this.
   */
  readonly estimatedSegments: number;
}

/**
 * Per-tenant, per-language notification templates (docs/01-mvp-scope.md §4.6 #6.4).
 *
 * A tenant overrides any built-in default; the defaults keep the pipeline working
 * out of the box, so a fresh tenant notifies correctly with no seeding.
 *
 * ⚠️ Placeholders are validated against the set the events actually populate. An
 * unrecognised token would render empty forever — the failure mode is a message
 * that looks fine in the editor and arrives with a hole in it.
 */
@Injectable()
export class TemplateService {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Every template for the tenant: overrides where they exist, defaults elsewhere.
   *
   * Merged rather than returning only overrides, because the question an operator
   * is asking is "what will my customers actually receive?" — and for most keys
   * the answer is the default.
   */
  async list(): Promise<readonly TemplateView[]> {
    return this.database.withTenant(async (tx) => {
      const overrides = await tx.select().from(notificationTemplates);

      const byKey = new Map<string, TemplateView>();

      // Defaults first, so an override replaces its own key and nothing else.
      for (const [key, byLocale] of Object.entries(DEFAULT_TEMPLATES)) {
        for (const locale of NOTIFICATION_LOCALES) {
          const body = byLocale[locale];
          byKey.set(`${key}|${locale}|SMS`, {
            key,
            locale,
            channel: "SMS",
            body,
            active: true,
            isDefault: true,
            estimatedSegments: estimateSegments(body),
          });
        }
      }

      for (const row of overrides) {
        const locale = row.locale as Locale;
        byKey.set(`${row.key}|${row.locale}|${row.channel}`, {
          key: row.key,
          locale,
          channel: row.channel,
          body: row.body,
          active: row.active,
          isDefault: false,
          estimatedSegments: estimateSegments(row.body),
        });
      }

      return [...byKey.values()].sort((a, b) =>
        a.key === b.key ? a.locale.localeCompare(b.locale) : a.key.localeCompare(b.key),
      );
    });
  }

  /** Creates or replaces one template. */
  async upsert(input: unknown): Promise<TemplateView> {
    const dto = parseWithZod(upsertTemplateSchema, input);

    return this.database.withTenant(async (tx) => {
      const tenantId = TenantContext.requireTenantId();

      await tx
        .insert(notificationTemplates)
        .values({
          tenantId,
          key: dto.key,
          locale: dto.locale,
          channel: dto.channel,
          body: dto.body,
          active: dto.active ?? true,
        })
        .onConflictDoUpdate({
          target: [
            notificationTemplates.tenantId,
            notificationTemplates.key,
            notificationTemplates.locale,
            notificationTemplates.channel,
          ],
          set: { body: dto.body, active: dto.active ?? true, updatedAt: sql`now()` },
        });

      return {
        key: dto.key,
        locale: dto.locale,
        channel: dto.channel,
        body: dto.body,
        active: dto.active ?? true,
        isDefault: false,
        estimatedSegments: estimateSegments(dto.body),
      };
    });
  }

  /**
   * Reverts a key to the built-in default by removing the override.
   *
   * Deactivating instead of deleting would leave a row that resolves to nothing
   * and silently stop notifying — reverting must restore working behaviour, not
   * remove it.
   */
  async revert(input: unknown): Promise<{ reverted: boolean }> {
    const dto = parseWithZod(previewSchema, input);

    return this.database.withTenant(async (tx) => {
      const removed = await tx
        .delete(notificationTemplates)
        .where(
          and(
            eq(notificationTemplates.key, dto.key),
            eq(notificationTemplates.locale, dto.locale),
            eq(notificationTemplates.channel, dto.channel),
          ),
        )
        .returning({ id: notificationTemplates.id });

      return { reverted: removed.length > 0 };
    });
  }

  /**
   * Renders a template with sample values, so an operator sees what a customer
   * will see BEFORE it is live.
   *
   * The sample deliberately uses realistic Tunisian values: a tracking number of
   * the real shape and an Arabic name, because a template that fits in 160
   * characters with "John Smith" may not with "محمد بن عبد الله".
   */
  async preview(input: unknown): Promise<{ body: string; estimatedSegments: number }> {
    const dto = parseWithZod(previewSchema, input);

    const resolved = await this.database.withTenant(async (tx) => {
      const rows = await tx
        .select({ body: notificationTemplates.body })
        .from(notificationTemplates)
        .where(
          and(
            eq(notificationTemplates.key, dto.key),
            eq(notificationTemplates.locale, dto.locale),
            eq(notificationTemplates.channel, dto.channel),
            eq(notificationTemplates.active, true),
          ),
        )
        .limit(1);
      return rows[0]?.body ?? DEFAULT_TEMPLATES[dto.key]?.[dto.locale] ?? null;
    });

    if (resolved === null) {
      return { body: "", estimatedSegments: 0 };
    }

    const body = renderTemplate(resolved, SAMPLE_PARAMS);
    return { body, estimatedSegments: estimateSegments(body) };
  }
}

/**
 * Realistic sample values for a preview.
 *
 * Arabic name on purpose: an Arabic body is UCS-2 at 70 characters per segment, so
 * a template that looks fine with a Latin name can cost an extra segment with a
 * real one — which is exactly what a preview is for.
 */
const SAMPLE_PARAMS: Readonly<Record<string, unknown>> = {
  trackingNumber: "TN-20260729-0042",
  recipientName: "محمد بن عبد الله",
  merchantName: "Boutique Ines",
  parcelCount: 12,
  reference: "STL-20260729-003",
  amount: "1 250,500 TND",
  stopCount: 18,
  plannedDate: "2026-07-30",
  reason: "Destinataire absent",
};
