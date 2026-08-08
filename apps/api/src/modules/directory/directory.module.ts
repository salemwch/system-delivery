import { Module } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";

import { AppConfigService } from "../../shared/config/index.js";

import { PlatformModule } from "../platform/index.js";
import { MerchantApplicationController } from "./api/merchant-application.controller.js";
import { MerchantController } from "./api/merchant.controller.js";
import { RecipientController } from "./api/recipient.controller.js";
import { AddressService } from "./application/address.service.js";
import { MerchantApplicationService } from "./application/merchant-application.service.js";
import { MerchantService } from "./application/merchant.service.js";
import { RecipientService } from "./application/recipient.service.js";
import { GEOCODING_PROVIDER } from "./domain/geocoding.js";
import type { GeocodingProvider } from "./domain/geocoding.js";
import { ChainedGeocodingProvider } from "./infrastructure/chained-geocoding.provider.js";
import { ManualGeocodingProvider } from "./infrastructure/manual-geocoding.provider.js";
import { NominatimGeocodingProvider } from "./infrastructure/nominatim-geocoding.provider.js";

/**
 * Directory context (docs/04-context-map.md §3.3) — Layer 1.
 *
 * Commercial counterparties and the address-quality pipeline. Depends on
 * `platform` (outbox for merchant.created / address.geocode_corrected) and the
 * shared database.
 */
@Module({
  imports: [PlatformModule],
  controllers: [MerchantController, RecipientController, MerchantApplicationController],
  providers: [
    MerchantService,
    MerchantApplicationService,
    RecipientService,
    AddressService,
    ManualGeocodingProvider,
    NominatimGeocodingProvider,
    {
      provide: GEOCODING_PROVIDER,
      /**
       * Resolved at boot from `GEOCODER`, defaulting to `manual`.
       *
       * The chain is built here rather than inside any provider, because the
       * ORDER is a deployment decision: cheapest and most private first, paid
       * fallback behind it. When a commercial vendor is chosen it is appended to
       * this array and nothing else in the codebase changes.
       */
      useFactory: (
        config: AppConfigService,
        manual: ManualGeocodingProvider,
        nominatim: NominatimGeocodingProvider,
        logger: PinoLogger,
      ): GeocodingProvider => {
        if (config.get("GEOCODER") !== "nominatim") {
          return manual;
        }
        return new ChainedGeocodingProvider([nominatim], logger);
      },
      inject: [AppConfigService, ManualGeocodingProvider, NominatimGeocodingProvider, PinoLogger],
    },
  ],
  exports: [MerchantService, MerchantApplicationService, RecipientService, AddressService],
})
export class DirectoryModule {}
