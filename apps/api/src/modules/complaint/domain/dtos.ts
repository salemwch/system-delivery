import { z } from "zod";

import {
  COMPLAINT_RAISERS,
  COMPLAINT_SEVERITIES,
  COMPLAINT_STATUSES,
  COMPLAINT_TYPES,
} from "./complaint-status.js";

/**
 * Validated input for the complaint module (docs/05-api-contracts.md).
 *
 * Strict throughout: a complaint is a legal-ish record that may be read in a
 * dispute months later, so an unknown key silently dropped is a field somebody
 * believed they had recorded.
 */

const nonEmpty = (label: string, max: number) =>
  z.string().trim().min(1, `${label} is required`).max(max);

export const createComplaintSchema = z
  .strictObject({
    type: z.enum(COMPLAINT_TYPES),
    severity: z.enum(COMPLAINT_SEVERITIES).optional(),
    /** Free text from the complainant. Generous limit — this is the evidence. */
    description: nonEmpty("description", 4000),

    shipmentId: z.uuid().optional(),
    merchantId: z.uuid().optional(),
    recipientId: z.uuid().optional(),
    driverId: z.uuid().optional(),

    raisedByType: z.enum(COMPLAINT_RAISERS),
    /** Object-storage keys for photos. Keys only; upload happens separately. */
    attachmentKeys: z.array(z.string().trim().min(1).max(512)).max(20).optional(),
    idempotencyKey: z.uuid(),
  })
  .superRefine((value, ctx) => {
    // A complaint that names nothing cannot be investigated, routed, or counted
    // against anything. At least one subject is required.
    if (
      value.shipmentId === undefined &&
      value.merchantId === undefined &&
      value.recipientId === undefined &&
      value.driverId === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["shipmentId"],
        message: "a complaint must reference a shipment, merchant, recipient, or driver",
      });
    }

    // A COD dispute is a claim on a specific parcel's cash. Without the shipment
    // there is nothing to reverse and no way to size the claim.
    if (value.type === "COD_DISPUTE" && value.shipmentId === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["shipmentId"],
        message: "COD_DISPUTE requires shipmentId — the reversal is scoped to one parcel",
      });
    }
  });

export const transitionComplaintSchema = z
  .strictObject({
    status: z.enum(COMPLAINT_STATUSES),
    /**
     * Required to reach RESOLVED or REJECTED — checked here for a field-level
     * 422, and enforced again by a CHECK constraint (rule 2). A closed complaint
     * with no recorded outcome is not a record of anything.
     */
    resolution: z.string().trim().min(1).max(4000).optional(),
    note: z.string().trim().min(1).max(2000).optional(),
    idempotencyKey: z.uuid(),
    /**
     * For a COD_DISPUTE resolved in the complainant's favour: reverse the
     * collected cash. Absent or false leaves the money where it is, which is the
     * right outcome for a dispute found to be unjustified.
     */
    reverseCod: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (
      (value.status === "RESOLVED" || value.status === "REJECTED") &&
      value.resolution === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["resolution"],
        message: `resolution is required to move a complaint to ${value.status}`,
      });
    }
    // Reversing money on a REJECTED complaint is a contradiction: the claim was
    // found to be without merit.
    if (value.reverseCod === true && value.status !== "RESOLVED") {
      ctx.addIssue({
        code: "custom",
        path: ["reverseCod"],
        message: "COD can only be reversed when a complaint is RESOLVED",
      });
    }
  });

export const assignComplaintSchema = z.strictObject({
  assignedToUserId: z.uuid(),
  note: z.string().trim().min(1).max(2000).optional(),
});

export const commentComplaintSchema = z.strictObject({
  note: nonEmpty("note", 2000),
});

export const listComplaintsQuerySchema = z.strictObject({
  status: z.enum(COMPLAINT_STATUSES).optional(),
  type: z.enum(COMPLAINT_TYPES).optional(),
  severity: z.enum(COMPLAINT_SEVERITIES).optional(),
  shipmentId: z.uuid().optional(),
  merchantId: z.uuid().optional(),
  assignedToUserId: z.uuid().optional(),
  /** Only complaints past their SLA. The dashboard's default filter. */
  overdueOnly: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.uuid().optional(),
});

export const setSlaPolicySchema = z.strictObject({
  type: z.enum(COMPLAINT_TYPES),
  dueHours: z.coerce.number().int().min(1).max(8760),
});
