import { Module } from "@nestjs/common";

import { FinanceModule } from "../finance/index.js";
import { PlatformModule } from "../platform/index.js";
import { ShipmentModule } from "../shipment/index.js";
import { ComplaintController } from "./api/complaint.controller.js";
import { ComplaintService } from "./application/complaint.service.js";

/**
 * Complaint context (docs/02-domain-model.md §3.20) — Layer 3.
 *
 * Depends on `shipment` to validate the parcel a complaint names (rule 1: same
 * tenant, and RLS makes a merchant's reach its own rows), and on `finance` to
 * post the reversing transaction a resolved COD_DISPUTE requires — the mechanism
 * that answers hotspot H8.
 *
 * Both are DOWNWARD or same-layer-sanctioned reads; the complaint module writes
 * nothing in either. It is the only module besides the finance consumers that
 * causes a ledger transaction, and it does so through `LedgerService`, the single
 * sanctioned writer.
 */
@Module({
  imports: [PlatformModule, ShipmentModule, FinanceModule],
  controllers: [ComplaintController],
  providers: [ComplaintService],
  exports: [ComplaintService],
})
export class ComplaintModule {}
