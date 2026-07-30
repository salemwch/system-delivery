import { Injectable } from "@nestjs/common";

import { parcelQrDataUri, parcelQrPng } from "../domain/parcel-qr.js";
import { ShipmentService } from "./shipment.service.js";

/** A rendered parcel label. */
export interface ShipmentLabel {
  readonly shipmentId: string;
  readonly trackingNumber: string;
  /** PNG bytes of the QR code. */
  readonly qrPng: Buffer;
  /** The same code as a data URI, for embedding straight into printable HTML. */
  readonly qrDataUri: string;
  readonly recipientName: string;
  readonly merchantId: string | null;
}

/**
 * Parcel label rendering (docs/01-mvp-scope.md §4.2 #2.15).
 *
 * The `trackingNumber` has existed since the first shipment migration and every
 * scan path already consumes it — pickup, hub inbound, and manifest receipt all
 * take it as input. Nothing ever rendered it, which meant the scan-based custody
 * chain had no way to start: a driver cannot scan a parcel that carries no code.
 *
 * The QR encoding decisions — bare tracking number, error-correction level M —
 * live in `domain/parcel-qr.ts`, shared with the printed documents so a label and
 * a bon de livraison always carry the same code.
 */
@Injectable()
export class LabelService {
  constructor(private readonly shipments: ShipmentService) {}

  /**
   * Renders the label for one shipment.
   *
   * Reads through {@link ShipmentService}, so RLS and the merchant scope
   * (invariant I24) apply: a merchant asking for another merchant's label gets
   * a not-found, not a picture of a rival's parcel.
   */
  async render(shipmentId: string): Promise<ShipmentLabel> {
    const shipment = await this.shipments.getById(shipmentId);

    const [qrPng, qrDataUri] = await Promise.all([
      parcelQrPng(shipment.trackingNumber),
      parcelQrDataUri(shipment.trackingNumber),
    ]);

    return {
      shipmentId: shipment.id,
      trackingNumber: shipment.trackingNumber,
      qrPng,
      qrDataUri,
      recipientName: shipment.recipientName,
      merchantId: shipment.merchantId,
    };
  }
}
