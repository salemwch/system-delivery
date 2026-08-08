import { Test } from "@nestjs/testing";
import { afterAll, describe, expect, it } from "vitest";
import type { TestingModule } from "@nestjs/testing";

import { AppModule } from "../src/app.module.js";
import { WorkerModule } from "../src/worker.module.js";

/**
 * The application's dependency graph actually resolves.
 *
 * ⚠️ THIS IS THE TEST THAT WAS MISSING. Every other suite constructs the service
 * under test by hand — `new PaymentNoteService(db, merchants, tenants, money)` —
 * which proves the service works and proves NOTHING about whether Nest can build
 * it. A service can inject a provider its own module never imports, pass its
 * whole suite, and take the API down on boot with an
 * `UnknownDependenciesException`. That is exactly what shipped: 1354 green tests
 * and an API that would not start.
 *
 * It has happened before for the same reason and is recorded in `AppModule` — a
 * missing `ValkeyModule` import left `VALKEY_CLIENT` unprovided and `tracking`
 * unresolvable. A comment was the only guard. Now there is a test.
 *
 * `compile()` is what does the work: it resolves and INSTANTIATES every provider
 * and controller in the graph, so a missing import, an unexported provider or a
 * circular dependency fails here rather than in production. `init()` is
 * deliberately NOT called — that would start listeners and background work, and
 * this suite is about the graph, not the runtime.
 */
describe("composition roots", () => {
  const opened: TestingModule[] = [];

  afterAll(async () => {
    // Closes the pg pools and Valkey clients that compiling the graphs opened.
    // Without this the process hangs on open handles rather than failing loudly.
    await Promise.all(opened.map(async (ref) => ref.close()));
  });

  /**
   * ⚠️ BOTH ROOTS, because they are DIFFERENT GRAPHS. The worker is not a subset
   * of the API — it binds the stream consumer and the relay the API deliberately
   * does not run, so a provider can resolve in one and not the other. Testing
   * only `AppModule` would leave `pnpm start:worker` exactly as unguarded as the
   * API was.
   */
  const roots = [
    { name: "AppModule (core-api)", module: AppModule },
    { name: "WorkerModule (core-worker)", module: WorkerModule },
  ] as const;

  for (const root of roots) {
    it(
      `resolves every provider in ${root.name}`,
      async () => {
        const moduleRef = await Test.createTestingModule({ imports: [root.module] }).compile();
        opened.push(moduleRef);

        expect(moduleRef).toBeDefined();
      },
      120_000,
    );
  }
});
