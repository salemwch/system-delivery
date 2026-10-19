import { APP_PIPE } from "@nestjs/core";
import { describe, expect, it } from "vitest";

import { IdentityModule } from "../src/modules/identity/identity.module.js";
import { ValidationError } from "../src/shared/errors/index.js";
import { UuidParamPipe } from "../src/shared/http/index.js";

/**
 * The global UUID route-parameter pipe. The HTTP behaviour (400, not 500) is
 * covered end to end in driver-authorization.http.spec.ts; this pins the
 * naming rule and that production actually binds the pipe.
 */
describe("UuidParamPipe", () => {
  const pipe = new UuidParamPipe();
  const id = "019a0c2e-7b3c-7f00-8a2b-1c2d3e4f5a6b";
  const param = (data: string) => ({ type: "param" as const, data });

  it("passes a UUID in id and *Id parameters through unchanged", () => {
    for (const name of ["id", "driverId", "hubId", "merchantId", "userId"]) {
      expect(pipe.transform(id, param(name))).toBe(id);
    }
  });

  it("refuses anything else in those parameters, naming the field", () => {
    for (const bad of ["not-a-uuid", "1", "", "'; drop table shipments;--", `${id}x`]) {
      expect(() => pipe.transform(bad, param("id"))).toThrow(ValidationError);
    }
    try {
      pipe.transform("x", param("driverId"));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).fieldErrors).toEqual([
        { field: "driverId", code: "INVALID_UUID", detail: "driverId must be a UUID" },
      ]);
    }
  });

  it("leaves identifiers that are not UUIDs by design, and bodies and queries, alone", () => {
    for (const name of ["code", "slug", "tenantSlug", "trackingNumber", "documentType", "key"]) {
      expect(pipe.transform("TN-123", param(name))).toBe("TN-123");
    }
    expect(pipe.transform({ id: "x" }, { type: "body" })).toEqual({ id: "x" });
    expect(pipe.transform("x", { type: "query", data: "id" })).toBe("x");
    expect(pipe.transform("x", { type: "custom" })).toBe("x");
  });

  it("is bound globally by the production IdentityModule", () => {
    const providers: unknown = Reflect.getMetadata("providers", IdentityModule);
    expect(providers).toContainEqual({ provide: APP_PIPE, useClass: UuidParamPipe });
  });
});
