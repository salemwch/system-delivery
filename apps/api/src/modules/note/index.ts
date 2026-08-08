/**
 * Note context public API — remarques.
 *
 * Staff remarks on a shipment, a merchant or a driver: written once, cleared by
 * resolving, never deleted.
 */
export { NoteModule } from "./note.module.js";
export { NoteService } from "./application/note.service.js";
export type { NoteView, NotePage } from "./application/note.service.js";

export { notes } from "./domain/schema.js";
export type { Note, NewNote } from "./domain/schema.js";

export { SUBJECT_TYPES } from "./domain/dtos.js";
export type {
  SubjectType,
  CreateNoteInput,
  UpdateNoteInput,
  ListNotesInput,
} from "./domain/dtos.js";
