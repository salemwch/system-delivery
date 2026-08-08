/**
 * Directory context public API (docs/04-context-map.md §3.3).
 *
 * A service layer: merchants, recipients, and the address-quality pipeline.
 * Everything other modules may use is exported here; internals stay unreachable.
 */
export { DirectoryModule } from "./directory.module.js";
export { MerchantService } from "./application/merchant.service.js";
export { RecipientService } from "./application/recipient.service.js";
export { AddressService } from "./application/address.service.js";
export { MerchantApplicationService } from "./application/merchant-application.service.js";

export type { ApplicationPage } from "./application/merchant-application.service.js";
export type { MerchantPage, ListMerchantsParams } from "./application/merchant.service.js";
export type { RecipientPage, ListRecipientsParams } from "./application/recipient.service.js";
export type { ResolvedAddress, AddressView } from "./application/address.service.js";

export { merchants, recipients, addresses, merchantApplications } from "./domain/schema.js";
export type {
  Merchant,
  NewMerchant,
  Recipient,
  NewRecipient,
  Address,
  NewAddress,
  MerchantApplication,
  NewMerchantApplication,
} from "./domain/schema.js";

export { AUTO_DISPATCH_CONFIDENCE_FLOOR, GEOCODING_PROVIDER } from "./domain/geocoding.js";
export type {
  GeocodingProvider,
  GeocodeQuery,
  GeocodeResult,
  Coordinates,
} from "./domain/geocoding.js";

export type {
  CreateMerchantInput,
  UpdateMerchantInput,
  CreateRecipientInput,
  UpdateRecipientInput,
  BlockRecipientInput,
  ResolveAddressInput,
  CorrectAddressInput,
  SubmitApplicationInput,
  ListApplicationsInput,
  ApproveApplicationInput,
  RejectApplicationInput,
} from "./domain/dtos.js";
