import { Injectable } from "@nestjs/common";

import { AddressService } from "../../directory/index.js";
import type { AddressView } from "../../directory/index.js";
import { TenantService } from "../../platform/index.js";
import { CurrencyService } from "../../../shared/money/index.js";
import { BusinessRuleError } from "../../../shared/errors/index.js";
import { renderDocument, toDocumentLocale } from "../domain/document.js";
import type { DocumentLocale, DocumentType } from "../domain/document.js";
import { parcelQrSvg } from "../domain/parcel-qr.js";
import type { Shipment } from "../domain/schema.js";
import { ShipmentService } from "./shipment.service.js";

/** A rendered document, ready to be served with the right content type. */
export interface RenderedDocument {
  readonly documentType: DocumentType;
  readonly locale: DocumentLocale;
  readonly trackingNumber: string;
  /** A complete, self-contained HTML page. */
  readonly html: string;
  /** Suggested download name, e.g. `bon-de-livraison-TN-4F2K9QX7.html`. */
  readonly filename: string;
}

/**
 * The statuses at which a bon de retour is a truthful document.
 *
 * ⚠️ A return note for a parcel that is not going back is a forgery with a
 * letterhead on it. It would be signed by a merchant as proof they took a parcel
 * that is in fact still out for delivery, so the guard is a rule, not a nicety.
 */
const RETURN_STATUSES: ReadonlySet<string> = new Set(["RETURN_PENDING", "RETURNED"]);

/** Filename stems per document type and locale — ASCII, because filenames travel badly. */
const FILENAME_STEM: Readonly<Record<DocumentType, string>> = {
  DELIVERY_NOTE: "bon-de-livraison",
  CONSIGNMENT_NOTE: "bon-d-envoi",
  RETURN_NOTE: "bon-de-retour",
};

/**
 * Delivery document generation (docs/01-mvp-scope.md §4.2 #2.14).
 *
 * Assembles a shipment, its two addresses, the courier's own letterhead and a
 * correctly-scaled COD amount into the print-ready HTML that
 * `domain/document.ts` renders. All reads go through existing services, so RLS and
 * the merchant scope (invariant I24) apply exactly as everywhere else: a merchant
 * requesting another merchant's bon de livraison gets a not-found, not a rival's
 * customer list on headed paper.
 *
 * ⚠️ The COD amount is formatted through {@link CurrencyService}, which reads the
 * exponent from the `currencies` table. **TND has three decimal places**, so a
 * hardcoded ×100 would print 12.50 for a 12.500 TND parcel — a document a driver
 * collects money against. That is the single most consequential number here, and it
 * is why the currency helpers were moved into `shared/`: `shipment` may not depend
 * on `finance`, and a local copy of money formatting was the alternative.
 */
@Injectable()
export class DocumentService {
  constructor(
    private readonly shipments: ShipmentService,
    private readonly addresses: AddressService,
    private readonly tenants: TenantService,
    private readonly currency: CurrencyService,
  ) {}

  /**
   * Renders one document for one shipment.
   *
   * `locale` falls back to the tenant's own default, then to French — an operator
   * who prints without choosing gets the language their paperwork is already in.
   */
  async render(
    shipmentId: string,
    documentType: DocumentType,
    locale?: string,
  ): Promise<RenderedDocument> {
    const shipment = await this.shipments.getById(shipmentId);
    this.assertApplicable(shipment, documentType);

    const profile = await this.tenants.profile();
    const resolvedLocale = toDocumentLocale(locale ?? profile.defaultLocale);

    // Fetched concurrently: four independent reads, and a document request is a
    // page load an operator waits on. Serially this is four round-trips.
    const [origin, destination, qrSvg, codAmount] = await Promise.all([
      this.addresses.getById(shipment.originAddressId),
      this.addresses.getById(shipment.destinationAddressId),
      parcelQrSvg(shipment.trackingNumber),
      this.codAmountOf(shipment),
    ]);

    const html = renderDocument({
      documentType,
      locale: resolvedLocale,
      courierName: profile.name,
      trackingNumber: shipment.trackingNumber,
      qrSvg,
      issuedAt: new Date(),
      timezone: profile.timezone,
      senderName: shipment.senderName,
      senderPhone: shipment.senderPhone,
      originLines: addressLines(origin),
      recipientName: shipment.recipientName,
      recipientPhone: shipment.recipientPhone,
      destinationLines: addressLines(destination),
      parcelCount: shipment.parcelCount,
      weightGrams: shipment.weightGrams,
      serviceLevel: shipment.serviceLevel,
      codAmount,
      currency: shipment.currency,
      // Access notes are the operationally useful free text on a delivery note —
      // "second floor, no lift", "call from the gate".
      notes: destination.accessNotes,
      returnReason: documentType === "RETURN_NOTE" ? await this.returnReasonOf(shipment.id) : null,
    });

    return {
      documentType,
      locale: resolvedLocale,
      trackingNumber: shipment.trackingNumber,
      html,
      filename: `${FILENAME_STEM[documentType]}-${shipment.trackingNumber}.html`,
    };
  }

  /**
   * A COD amount as a decimal string, or null when the parcel carries no COD.
   *
   * Null rather than "0.000": a document that prints a zero amount invites a
   * driver to ask for nothing and a recipient to wonder what it means. "Aucun" is
   * unambiguous.
   */
  private async codAmountOf(shipment: Shipment): Promise<string | null> {
    if (shipment.codAmountMinor <= 0n) {
      return null;
    }
    return this.currency.toDecimal(shipment.codAmountMinor, shipment.currency);
  }

  /** The reason recorded on the `return_initiated` event, when one was captured. */
  private async returnReasonOf(shipmentId: string): Promise<string | null> {
    const events = await this.shipments.getEvents(shipmentId);
    // Last one wins: a parcel can in principle be sent back more than once, and
    // the current document describes the current journey.
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event?.eventType === "return_initiated" && event.reasonCode !== null) {
        return event.reasonCode;
      }
    }
    return null;
  }

  private assertApplicable(shipment: Shipment, documentType: DocumentType): void {
    if (documentType === "RETURN_NOTE" && !RETURN_STATUSES.has(shipment.status)) {
      throw new BusinessRuleError(
        "DOCUMENT_NOT_APPLICABLE",
        `A return note requires a returning shipment; this one is ${shipment.status}.`,
      );
    }
  }
}

/**
 * The printable lines of an address.
 *
 * Falls back to `rawInput` when nothing has been normalised — an ungeocoded
 * address is ordinary in this market (docs/01 §MENA), and a blank address block on
 * a driver's paperwork is worse than an unstructured one.
 */
function addressLines(address: AddressView): readonly string[] {
  const structured = [
    address.normalisedLine1,
    address.normalisedLine2,
    [address.postalCode, address.city]
      .filter((part) => part !== null)
      .join(" ")
      .trim(),
    address.region,
  ].filter((line): line is string => line !== null && line.trim().length > 0);

  return structured.length > 0 ? structured : [address.rawInput];
}
