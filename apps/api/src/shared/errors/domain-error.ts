import { HttpStatus } from "@nestjs/common";

import type { FieldError } from "../http/problem-details.filter.js";

/**
 * Base class for errors the API deliberately exposes.
 *
 * Carries a stable machine-readable `code` that clients branch on. Anything
 * that is NOT a DomainError is treated as a bug and rendered as a generic
 * 500 with no internal detail (see ProblemDetailsFilter).
 *
 * Codes are registered in docs/05-api-contracts.md §1.2 — adding one here
 * without documenting it there leaves clients unable to handle it.
 */
export class DomainError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fieldErrors: readonly FieldError[];

  constructor(
    code: string,
    message: string,
    status: number = HttpStatus.BAD_REQUEST,
    fieldErrors: readonly FieldError[] = [],
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.fieldErrors = fieldErrors;
    Error.captureStackTrace(this, new.target);
  }
}

/** 400 — the request did not satisfy its schema. */
export class ValidationError extends DomainError {
  constructor(fieldErrors: readonly FieldError[], message = "Request validation failed") {
    super("VALIDATION_FAILED", message, HttpStatus.BAD_REQUEST, fieldErrors);
  }
}

/** 401 — no valid credentials. Never distinguishes WHY (enumeration oracle). */
export class UnauthenticatedError extends DomainError {
  constructor(message = "Authentication required") {
    super("UNAUTHENTICATED", message, HttpStatus.UNAUTHORIZED);
  }
}

/** 403 — authenticated, but not permitted. */
export class ForbiddenError extends DomainError {
  constructor(message = "You do not have permission to perform this action") {
    super("FORBIDDEN", message, HttpStatus.FORBIDDEN);
  }
}

/** 403 — the tenant's plan does not include this capability (TenantFeature). */
export class FeatureNotEntitledError extends DomainError {
  constructor(featureKey: string) {
    super(
      "FEATURE_NOT_ENTITLED",
      `This feature is not enabled for your account (${featureKey}).`,
      HttpStatus.FORBIDDEN,
    );
  }
}

/**
 * 404 — not found, OR not visible to this tenant.
 *
 * Deliberately indistinguishable: returning 403 for another tenant's resource
 * confirms it exists, which is an enumeration oracle
 * (docs/07-security-architecture.md §4.3).
 */
export class NotFoundError extends DomainError {
  constructor(resource: string) {
    super("NOT_FOUND", `${resource} not found`, HttpStatus.NOT_FOUND);
  }
}

/** 409 — the operation conflicts with current state. */
export class ConflictError extends DomainError {
  constructor(code: string, message: string) {
    super(code, message, HttpStatus.CONFLICT);
  }
}

/** 422 — well-formed but violates a business rule. */
export class BusinessRuleError extends DomainError {
  constructor(code: string, message: string, fieldErrors: readonly FieldError[] = []) {
    super(code, message, HttpStatus.UNPROCESSABLE_ENTITY, fieldErrors);
  }
}
