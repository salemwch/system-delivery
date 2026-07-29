import { Injectable } from "@nestjs/common";
import QRCode from "qrcode";

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
 * Error correction level.
 *
 * `M` (~15% recoverable) rather than the default `L`. A parcel label gets
 * scuffed, taped over, and rained on between the merchant's table and the
 * recipient's door; the extra redundancy costs a slightly denser code and buys
 * scans that would otherwise fail in the field.
 */
const ERROR_CORRECTION = "M" as const;

/** Printed at ~30mm on a thermal label; 8 px/module keeps it crisp at 203 dpi. */
const MODULE_SCALE = 8;

/**
 * Parcel label rendering (docs/01-mvp-scope.md §4.2 #2.15).
 *
 * The `trackingNumber` has existed since the first shipment migration and every
 * scan path already consumes it — pickup, hub inbound, and manifest receipt all
 * take it as input. Nothing ever rendered it, which meant the scan-based custody
 * chain had no way to start: a driver cannot scan a parcel that carries no code.
 *
 * The payload is deliberately the **bare tracking number**, not a URL and not
 * JSON. Three reasons:
 *
 *  1. Every existing scan endpoint expects exactly that string, so a scanned
 *     label round-trips into custody with no parsing layer to disagree.
 *  2. It keeps the code sparse, which scans faster on a cheap handheld and
 *     survives more damage.
 *  3. A URL would leak the deployment's hostname onto every parcel and would
 *     break the moment the domain changes — while the tracking number is
 *     already the shipment's public identity (domain rule 10).
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

    const options = {
      errorCorrectionLevel: ERROR_CORRECTION,
      scale: MODULE_SCALE,
      margin: 2,
    } as const;

    const [qrPng, qrDataUri] = await Promise.all([
      QRCode.toBuffer(shipment.trackingNumber, options),
      QRCode.toDataURL(shipment.trackingNumber, options),
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
