import { Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { DatabaseService } from "../../../shared/database/index.js";

/** The queues behind the sidebar badges. */
export const WORKLOAD_QUEUES = [
  "remarks",
  "applications",
  "amendments",
  "support",
  "expenses",
  "lowStock",
  "addressCorrections",
] as const;
export type WorkloadQueue = (typeof WORKLOAD_QUEUES)[number];
export type WorkloadCounts = Readonly<Record<WorkloadQueue, number>>;

/**
 * One scalar subquery per queue. Each is an indexed count over a partial index
 * (`notes_tenant_open_idx`, `expenses_pending_idx`, `address_corrections_pending_idx`
 * and the rest), so the statement is a handful of index-only scans.
 *
 * Fixed fragments, never built from input: the caller chooses WHICH of these
 * run, not what they say.
 */
const COUNT_SQL: Readonly<Record<WorkloadQueue, SQL>> = {
  remarks: sql`(select count(*)::int from notes where resolved_at is null)`,
  applications: sql`(select count(*)::int from merchant_applications where status = 'PENDING')`,
  amendments: sql`(select count(*)::int from shipment_amendments where status = 'PENDING')`,
  support: sql`(select count(*)::int from support_tickets
                 where status in ('OPEN', 'PENDING_MERCHANT'))`,
  expenses: sql`(select count(*)::int from expenses where status = 'DRAFT')`,
  lowStock: sql`(select count(*)::int
                   from inventory_levels l
                   join inventory_items i on i.id = l.item_id
                  where i.reorder_level is not null
                    and l.quantity <= i.reorder_level)`,
  addressCorrections: sql`(select count(*)::int from address_corrections
                            where status = 'PENDING_REVIEW')`,
};

/**
 * What is waiting for someone, in one number per queue: the sidebar badges.
 *
 * ⚠️ ONE STATEMENT, and it reads the tables directly. The sidebar renders on
 * every page, so a count per owning service would be a round trip per queue per
 * navigation, and would make `platform` (layer 0) depend on every module above
 * it, closing a cycle the boundary rules forbid. This is the codebase's one
 * deliberate exception: integers, no business rule. RLS filters every count
 * exactly as the owning service's read would, because `withTenant` sets the
 * same GUCs.
 *
 * ⚠️ RLS IS NOT AUTHORIZATION. Several of these tables are tenant-wide by
 * design (applications, expenses, stock), so a count is only as private as the
 * permission that guards the queue's own list. The caller passes the queues it
 * is allowed to open (the controller derives them from the principal), and a
 * queue not passed is never queried and reads 0.
 */
@Injectable()
export class WorkloadService {
  constructor(private readonly database: DatabaseService) {}

  async counts(queues: ReadonlySet<WorkloadQueue>): Promise<WorkloadCounts> {
    const zeros: Record<WorkloadQueue, number> = {
      remarks: 0,
      applications: 0,
      amendments: 0,
      support: 0,
      expenses: 0,
      lowStock: 0,
      addressCorrections: 0,
    };
    const asked = WORKLOAD_QUEUES.filter((queue) => queues.has(queue));
    if (asked.length === 0) {
      return zeros;
    }

    return this.database.withTenant(async (tx) => {
      const columns = sql.join(
        asked.map((queue) => sql`${COUNT_SQL[queue]} as ${sql.identifier(queue)}`),
        sql`, `,
      );
      const rows = await tx.execute<Record<string, unknown>>(sql`select ${columns}`);
      const row = rows[0];
      for (const queue of asked) {
        const value = row?.[queue];
        zeros[queue] = typeof value === "number" ? value : 0;
      }
      return zeros;
    });
  }
}
