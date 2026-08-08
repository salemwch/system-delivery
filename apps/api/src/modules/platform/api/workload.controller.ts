import { Controller, Get } from "@nestjs/common";
import { sql } from "drizzle-orm";

import { DatabaseService } from "../../../shared/database/index.js";

/**
 * What is waiting for someone, in one number per queue.
 *
 * ⚠️ ONE ENDPOINT AND ONE QUERY, and both halves matter. The sidebar renders on
 * EVERY page, so six separate counts would be six round trips per navigation —
 * and six services, which would make `platform` (layer 0) depend on six modules
 * above it and close a dependency cycle the boundary rules forbid.
 *
 * So it reads the tables directly with raw SQL. That is a deliberate exception
 * and the ONLY one in the codebase: this is a read of six integers with no
 * business rule attached, and routing it through six owning services would cost
 * the architecture more than the coupling is worth. Every count is filtered by
 * RLS exactly as the owning service's would be, because `withTenant` sets the
 * same GUC.
 *
 * ⚠️ Deliberately NOT permission-gated per queue. The numbers are counts, not
 * contents, and gating each one would need this controller to know six
 * permission names. The SIDEBAR already hides a section a role cannot open, so a
 * badge for an invisible section is never rendered — and a bare count of open
 * support tickets discloses nothing a staff member should not see.
 */
interface WorkloadCounts {
  readonly remarks: number;
  readonly applications: number;
  readonly amendments: number;
  readonly support: number;
  readonly expenses: number;
  readonly lowStock: number;
}

@Controller("v1/workload")
export class WorkloadController {
  constructor(private readonly database: DatabaseService) {}

  /**
   * No `@Public()`: every count is tenant-scoped and needs a session, so the
   * global deny-by-default AuthGuard applies. No `@RequirePermissions` either —
   * see the class comment.
   */
  @Get()
  async counts(): Promise<WorkloadCounts> {
    return this.database.withTenant(async (tx) => {
      // One statement, six scalar subqueries. Each is an indexed count over a
      // partial index — `notes_tenant_open_idx`, `expenses_pending_idx` and the
      // rest — so the whole thing is six index-only scans, not six table scans.
      const rows = await tx.execute<{
        remarks: number;
        applications: number;
        amendments: number;
        support: number;
        expenses: number;
        low_stock: number;
      }>(sql`
        select
          (select count(*)::int from notes where resolved_at is null) as remarks,
          (select count(*)::int from merchant_applications where status = 'PENDING') as applications,
          (select count(*)::int from shipment_amendments where status = 'PENDING') as amendments,
          (select count(*)::int from support_tickets
            where status in ('OPEN', 'PENDING_MERCHANT')) as support,
          (select count(*)::int from expenses where status = 'DRAFT') as expenses,
          (select count(*)::int
             from inventory_levels l
             join inventory_items i on i.id = l.item_id
            where i.reorder_level is not null
              and l.quantity <= i.reorder_level) as low_stock
      `);

      const row = rows[0];
      return {
        remarks: row?.remarks ?? 0,
        applications: row?.applications ?? 0,
        amendments: row?.amendments ?? 0,
        support: row?.support ?? 0,
        expenses: row?.expenses ?? 0,
        lowStock: row?.low_stock ?? 0,
      };
    });
  }
}
