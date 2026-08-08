import { Module } from "@nestjs/common";

import { PlatformModule } from "../platform/index.js";
import { SupportController } from "./api/support.controller.js";
import { SupportService } from "./application/support.service.js";

/**
 * Support context — the merchant/back-office conversation.
 *
 * Layer 3, and imports nothing above layer 0. A ticket is ABOUT a merchant and
 * sometimes a parcel, but this module never reads those contexts: the links are
 * composite foreign keys in migration 0039, so the database proves they exist
 * without support knowing what a shipment is.
 */
@Module({
  imports: [PlatformModule],
  controllers: [SupportController],
  providers: [SupportService],
  exports: [SupportService],
})
export class SupportModule {}
