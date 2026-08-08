import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { z } from "zod";

import { zodBody } from "../../../shared/http/index.js";
import { CurrentPrincipal, RequirePermissions } from "../../identity/index.js";
import type { Principal } from "../../identity/index.js";
import { NoteService } from "../application/note.service.js";
import type { NoteView } from "../application/note.service.js";
import { SUBJECT_TYPES, createNoteSchema, updateNoteSchema } from "../domain/dtos.js";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
  subjectType: z.enum(SUBJECT_TYPES).optional(),
  subjectId: z.string().min(1).optional(),
  authorUserId: z.string().min(1).optional(),
  resolved: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

interface NoteResponse {
  readonly id: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly body: string;
  readonly authorUserId: string;
  /** Resolved in the list query — a note without a name is unreadable. */
  readonly authorName: string | null;
  readonly pinned: boolean;
  readonly resolvedAt: string | null;
  readonly resolvedByUserId: string | null;
  readonly createdAt: string;
}

interface PageResponse<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

/**
 * Remarques.
 *
 * `note:read` and `note:manage`, held by staff only. Neither MERCHANT nor
 * COMMERCIAL has either — see the catalogue entry for why that is the design
 * and not an oversight.
 */
@Controller("v1/notes")
export class NoteController {
  constructor(private readonly notes: NoteService) {}

  @Post()
  @RequirePermissions("note:manage")
  async create(
    @Body(zodBody(createNoteSchema)) body: z.infer<typeof createNoteSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<NoteResponse> {
    // The author comes from the token, never the body: a note is a statement
    // about who said what, and a caller-supplied author makes it worthless.
    return toResponse(await this.notes.create(body, principal.userId));
  }

  @Get()
  @RequirePermissions("note:read")
  async list(@Query() query: unknown): Promise<PageResponse<NoteResponse>> {
    const parsed = listQuerySchema.parse(query);
    const page = await this.notes.list({
      ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
      ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
      ...(parsed.subjectType === undefined ? {} : { subjectType: parsed.subjectType }),
      ...(parsed.subjectId === undefined ? {} : { subjectId: parsed.subjectId }),
      ...(parsed.authorUserId === undefined ? {} : { authorUserId: parsed.authorUserId }),
      ...(parsed.resolved === undefined ? {} : { resolved: parsed.resolved }),
    });
    return {
      data: page.items.map(toResponse),
      page: { nextCursor: page.nextCursor, hasMore: page.nextCursor !== null },
    };
  }

  /**
   * How many remarks are open.
   *
   * Declared before `:id` — Nest matches in declaration order, and "count"
   * is a perfectly valid path segment for an id parameter.
   */
  @Get("count")
  @RequirePermissions("note:read")
  async count(): Promise<{ readonly open: number }> {
    return { open: await this.notes.openCount() };
  }

  @Get(":id")
  @RequirePermissions("note:read")
  async getById(@Param("id") id: string): Promise<NoteResponse> {
    return toResponse(await this.notes.getById(id));
  }

  /** Pin, unpin, resolve, reopen. The body is frozen by migration 0035. */
  @Patch(":id")
  @RequirePermissions("note:manage")
  async update(
    @Param("id") id: string,
    @Body(zodBody(updateNoteSchema)) body: z.infer<typeof updateNoteSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<NoteResponse> {
    return toResponse(await this.notes.update(id, body, principal.userId));
  }
}

function toResponse(note: NoteView): NoteResponse {
  return {
    id: note.id,
    subjectType: note.subjectType,
    subjectId: note.subjectId,
    body: note.body,
    authorUserId: note.authorUserId,
    authorName: note.authorName,
    pinned: note.pinned,
    resolvedAt: note.resolvedAt?.toISOString() ?? null,
    resolvedByUserId: note.resolvedByUserId,
    createdAt: note.createdAt.toISOString(),
  };
}
