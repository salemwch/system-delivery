import { Controller, Get } from "@nestjs/common";

import { WORKLOAD_QUEUES, WorkloadService } from "../../platform/index.js";
import type { WorkloadCounts, WorkloadQueue } from "../../platform/index.js";
import type { Principal } from "../application/token.service.js";
import type { Permission } from "../domain/permissions.js";
import { CurrentPrincipal } from "./request-context.js";

/**
 * Each badge is guarded by the permission of the queue's OWN list route. A
 * count discloses exactly what opening the queue would, and nothing more: a
 * driver, who holds none of these, sees only zeros.
 *
 * Typed as a total record, so a queue added to `WORKLOAD_QUEUES` without a
 * permission here is a compile error rather than an ungated count.
 */
const QUEUE_PERMISSION: Readonly<Record<WorkloadQueue, Permission>> = {
  remarks: "note:read",
  applications: "merchant:read",
  amendments: "shipment:read",
  support: "support:read",
  expenses: "expense:read",
  lowStock: "inventory:read",
  addressCorrections: "address:review",
};

/**
 * What is waiting for the caller, one number per queue (the sidebar badges).
 *
 * ⚠️ LIVES IN `identity`, NOT `platform`: the gating needs the principal's
 * permissions, and `platform` (layer 0) may not import `identity` (see
 * TenantSettingsController). The query stays in `platform` as WorkloadService.
 *
 * No `@RequirePermissions`: every authenticated member of the tenant may call
 * it, and gets a zero for every queue they cannot open. A 403 instead would
 * break the app shell for roles with no queues at all, and the badge is never
 * rendered for a section the sidebar hides anyway.
 */
@Controller("v1/workload")
export class WorkloadController {
  constructor(private readonly workload: WorkloadService) {}

  @Get()
  async counts(@CurrentPrincipal() principal: Principal): Promise<WorkloadCounts> {
    const open = new Set<WorkloadQueue>(
      WORKLOAD_QUEUES.filter((queue) => principal.permissions.has(QUEUE_PERMISSION[queue])),
    );
    return this.workload.counts(open);
  }
}
