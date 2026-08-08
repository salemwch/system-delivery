import { z } from "zod";

/**
 * Validated input contracts for the note module.
 *
 * ⚠️ The subject is a DISCRIMINATED UNION, not three optional ids. A note with
 * two subjects, or none, violates `notes_one_subject_chk` and would surface as a
 * raw 23514 from the database instead of a field error the operator can act on.
 * Zod refuses it at the boundary and names the field.
 */

export const SUBJECT_TYPES = ["SHIPMENT", "MERCHANT", "DRIVER"] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];

/**
 * The fields every branch carries, spelled once.
 *
 * Spread into each strictObject rather than intersected with the union: an
 * intersection of a strict union with a second object rejects that object's own
 * keys as unknown, so every valid request fails validation.
 */
const contentShape = {
  body: z.string().trim().min(1, "body is required").max(2000),
  /** A standing warning rather than a dated observation. */
  pinned: z.boolean().optional(),
  subjectId: z.uuid(),
} as const;

export const createNoteSchema = z.discriminatedUnion("subjectType", [
  z.strictObject({ subjectType: z.literal("SHIPMENT"), ...contentShape }),
  z.strictObject({ subjectType: z.literal("MERCHANT"), ...contentShape }),
  z.strictObject({ subjectType: z.literal("DRIVER"), ...contentShape }),
]);
export type CreateNoteInput = z.infer<typeof createNoteSchema>;

export const listNotesSchema = z.strictObject({
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.uuid().optional(),
  subjectType: z.enum(SUBJECT_TYPES).optional(),
  subjectId: z.uuid().optional(),
  /** Default is OPEN only — the queue is the open set. */
  resolved: z.boolean().optional(),
  authorUserId: z.uuid().optional(),
});
export type ListNotesInput = z.infer<typeof listNotesSchema>;

export const updateNoteSchema = z
  .strictObject({
    // The body is absent on purpose: migration 0035 freezes it. A correction is
    // a new note, so there is no field here that could ask for one.
    pinned: z.boolean().optional(),
    resolved: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "at least one field must be provided",
  });
export type UpdateNoteInput = z.infer<typeof updateNoteSchema>;
