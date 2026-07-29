import { Controller, Get, Query } from "@nestjs/common";

import { RequirePermissions } from "../../identity/index.js";
import { AddressBookService } from "../application/address-book.service.js";
import type { AddressBookEntry } from "../application/address-book.service.js";

/**
 * The address book a merchant re-uses when creating a parcel
 * (docs/02-domain-model.md §3.19, open decision RM-R1).
 *
 * Guarded by `shipment:read`, NOT `recipient:read`, and that is the whole
 * design: the entries are a projection of the caller's own shipments, which
 * migration 0020 already narrows to their merchant inside RLS. A merchant
 * therefore never touches the tenant-wide `recipients` table, which holds
 * every rival's buyers.
 */

interface AddressBookEntryResponse {
  readonly phone: string;
  readonly fullName: string;
  readonly recipientId: string | null;
  readonly lastDestinationAddressId: string | null;
  readonly totalShipments: number;
  readonly delivered: number;
  readonly returned: number;
  readonly lastShipmentAt: string;
}

interface PageResponse<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

@Controller("v1/address-book")
export class AddressBookController {
  constructor(private readonly addressBook: AddressBookService) {}

  @Get()
  @RequirePermissions("shipment:read")
  async list(@Query() query: unknown): Promise<PageResponse<AddressBookEntryResponse>> {
    const page = await this.addressBook.list(query);
    return {
      data: page.items.map(toResponse),
      page: { nextCursor: page.nextCursor, hasMore: page.nextCursor !== null },
    };
  }
}

function toResponse(entry: AddressBookEntry): AddressBookEntryResponse {
  return {
    phone: entry.phone,
    fullName: entry.fullName,
    recipientId: entry.recipientId,
    lastDestinationAddressId: entry.lastDestinationAddressId,
    totalShipments: entry.totalShipments,
    delivered: entry.delivered,
    returned: entry.returned,
    lastShipmentAt: entry.lastShipmentAt.toISOString(),
  };
}
