import { ArgumentsHost, Catch, HttpException, HttpStatus, Logger } from "@nestjs/common";
import type { ExceptionFilter } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

import { DomainError } from "../errors/domain-error.js";

/**
 * RFC 9457 Problem Details error responses.
 *
 * Every error leaving this API has the same shape, so clients branch on a
 * stable `code` rather than parsing prose (docs/05-api-contracts.md §1.1).
 *
 * Two security properties are enforced here, not left to callers:
 *   - Internal detail never escapes. Stack traces, SQL, and driver messages are
 *     logged server-side and replaced with a generic message.
 *   - `requestId` is the ONLY correlation handle given to a client.
 */

interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance: string;
  readonly code: string;
  readonly requestId: string;
  readonly errors?: readonly FieldError[];
}

export interface FieldError {
  readonly field: string;
  readonly code: string;
  readonly detail: string;
}

/** Statuses at or above this are our fault and get logged in full. */
const SERVER_ERROR_THRESHOLD = 500;

const PROBLEM_BASE = "https://api.delivery-platform.local/problems";

/** HTTP status → default machine-readable code, for errors without a domain code. */
const STATUS_CODES: Readonly<Record<number, string>> = {
  400: "BAD_REQUEST",
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  405: "METHOD_NOT_ALLOWED",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  422: "UNPROCESSABLE_ENTITY",
  429: "RATE_LIMITED",
  500: "INTERNAL_ERROR",
  503: "SERVICE_UNAVAILABLE",
};

function titleFor(status: number): string {
  const text = STATUS_CODES[status] ?? "ERROR";
  return text
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<FastifyRequest>();
    const reply = context.getResponse<FastifyReply>();

    const requestId = typeof request.id === "string" ? request.id : "unknown";
    const instance = request.url;

    const problem = this.toProblem(exception, instance, requestId);

    // 5xx means we broke something: log the whole thing. 4xx is the client's
    // problem and is logged at debug to avoid drowning real incidents.
    if (problem.status >= SERVER_ERROR_THRESHOLD) {
      this.logger.error(
        { err: exception, requestId, path: instance },
        `Unhandled error: ${problem.code}`,
      );
    } else {
      this.logger.debug({ requestId, path: instance, code: problem.code }, "Request failed");
    }

    void reply.status(problem.status).type("application/problem+json").send(problem);
  }

  private toProblem(exception: unknown, instance: string, requestId: string): ProblemDetails {
    if (exception instanceof DomainError) {
      return {
        type: `${PROBLEM_BASE}/${exception.code.toLowerCase().replace(/_/g, "-")}`,
        title: titleFor(exception.status),
        status: exception.status,
        detail: exception.message,
        instance,
        code: exception.code,
        requestId,
        ...(exception.fieldErrors.length > 0 ? { errors: exception.fieldErrors } : {}),
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const detail =
        typeof response === "string"
          ? response
          : (this.extractMessage(response) ?? exception.message);

      const code = STATUS_CODES[status] ?? "ERROR";

      return {
        type: `${PROBLEM_BASE}/${code.toLowerCase().replace(/_/g, "-")}`,
        title: titleFor(status),
        status,
        detail,
        instance,
        code,
        requestId,
      };
    }

    // Anything else is a bug. Say nothing useful to the client.
    return {
      type: `${PROBLEM_BASE}/internal-error`,
      title: "Internal Error",
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      detail: "An unexpected error occurred. Quote the request id when contacting support.",
      instance,
      code: "INTERNAL_ERROR",
      requestId,
    };
  }

  private extractMessage(response: object): string | undefined {
    if ("message" in response) {
      const { message } = response;
      if (typeof message === "string") {
        return message;
      }
      if (Array.isArray(message)) {
        return message.filter((item): item is string => typeof item === "string").join("; ");
      }
    }
    return undefined;
  }
}
