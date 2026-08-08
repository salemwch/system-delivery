import { Module } from "@nestjs/common";

import { NoteController } from "./api/note.controller.js";
import { NoteService } from "./application/note.service.js";

/**
 * Note context — remarques.
 *
 * Layer 3, and imports nothing above layer 0. A note is ABOUT a shipment, a
 * merchant or a driver, but it never reads those contexts: the link is three
 * foreign keys in migration 0035, so the database proves the subject exists
 * without this module knowing what a shipment is.
 */
@Module({
  controllers: [NoteController],
  providers: [NoteService],
  exports: [NoteService],
})
export class NoteModule {}
