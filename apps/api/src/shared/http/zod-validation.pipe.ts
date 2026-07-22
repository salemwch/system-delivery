import { Injectable } from "@nestjs/common";
import type { PipeTransform } from "@nestjs/common";
import type { ZodType } from "zod";

import { ValidationError } from "../errors/domain-error.js";
import type { FieldError } from "./problem-details.filter.js";

/**
 * Validates and parses request input with a Zod schema.
 *
 * One schema per boundary drives DTO validation, OpenAPI generation, and the
 * shared client types — which is precisely why Zod replaces class-validator
 * here rather than sitting alongside it (see the "one tool per job" registry
 * in CLAUDE.md).
 *
 * Schemas MUST use `.strict()` so unknown properties are rejected rather than
 * silently stripped. Stripping hides client bugs; rejecting surfaces them, and
 * it is the mass-assignment defence (docs/07-security-architecture.md §4.5).
 */
@Injectable()
export class ZodValidationPipe<TOutput> implements PipeTransform<unknown, TOutput> {
  constructor(private readonly schema: ZodType<TOutput>) {}

  transform(value: unknown): TOutput {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      const fieldErrors: FieldError[] = result.error.issues.map((issue) => ({
        field: issue.path.length > 0 ? issue.path.join(".") : "(root)",
        code: issue.code.toUpperCase(),
        detail: issue.message,
      }));
      throw new ValidationError(fieldErrors);
    }

    return result.data;
  }
}

/** Convenience factory so controllers read as `@Body(zodBody(schema))`. */
export function zodBody<TOutput>(schema: ZodType<TOutput>): ZodValidationPipe<TOutput> {
  return new ZodValidationPipe(schema);
}
