import { Injectable } from "@nestjs/common";
import type { ArgumentMetadata, PipeTransform } from "@nestjs/common";
import { z } from "zod";

import { ValidationError } from "../errors/index.js";

/**
 * Route parameters that hold a UUID: `id`, or any `somethingId`. Every one in
 * the API follows this convention (`:id`, `:driverId`, `:hubId`, `:merchantId`,
 * `:userId`); identifiers that are not UUIDs by design are named for what they
 * are (`:code`, `:slug`, `:tenantSlug`, `:trackingNumber`, `:documentType`,
 * `:key`) and pass through untouched.
 */
const UUID_PARAM_NAME = /^(?:id|[a-z][A-Za-z0-9]*Id)$/u;
const uuid = z.uuid();

/**
 * Rejects a malformed UUID route parameter with `400 VALIDATION_FAILED`.
 *
 * ⚠️ THE DEFECT THIS CLOSES. Without it `GET /v1/shipments/not-a-uuid` reached
 * PostgreSQL, failed the `::uuid` cast (SQLSTATE 22P02), and came back as
 * `500 INTERNAL_ERROR`: a client mistake reported as a server fault, a 5xx
 * alert for every probe, and a stack trace in the logs for each one.
 *
 * Bound once as a global pipe (APP_PIPE) rather than written on each of the
 * ~130 parameters, so a route added tomorrow is covered without anyone
 * remembering to. Translating 22P02 in the error filter instead was rejected:
 * it would also relabel a genuine bad cast in our own SQL as the client's
 * fault, and hide the bug.
 */
@Injectable()
export class UuidParamPipe implements PipeTransform<unknown, unknown> {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const name = metadata.data;
    if (metadata.type !== "param" || name === undefined || !UUID_PARAM_NAME.test(name)) {
      return value;
    }
    if (!uuid.safeParse(value).success) {
      throw new ValidationError([
        { field: name, code: "INVALID_UUID", detail: `${name} must be a UUID` },
      ]);
    }
    return value;
  }
}
