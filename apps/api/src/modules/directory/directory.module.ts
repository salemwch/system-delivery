import { Module } from "@nestjs/common";

import { PlatformModule } from "../platform/index.js";
import { MerchantController } from "./api/merchant.controller.js";
import { RecipientController } from "./api/recipient.controller.js";
import { AddressService } from "./application/address.service.js";
import { MerchantService } from "./application/merchant.service.js";
import { RecipientService } from "./application/recipient.service.js";
import { GEOCODING_PROVIDER } from "./domain/geocoding.js";
import { ManualGeocodingProvider } from "./infrastructure/manual-geocoding.provider.js";

/**
 * Directory context (docs/04-context-map.md §3.3) — Layer 1.
 *
 * Commercial counterparties and the address-quality pipeline. Depends on
 * `platform` (outbox for merchant.created / address.geocode_corrected) and the
 * shared database.
 */
@Module({
  imports: [PlatformModule],
  controllers: [MerchantController, RecipientController],
  providers: [
    MerchantService,
    RecipientService,
    AddressService,
    { provide: GEOCODING_PROVIDER, useClass: ManualGeocodingProvider },
  ],
  exports: [MerchantService, RecipientService, AddressService],
})
export class DirectoryModule {}
