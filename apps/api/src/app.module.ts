import { Module } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";

import { ComplaintModule } from "./modules/complaint/index.js";
import { CustodyModule } from "./modules/custody/index.js";
import { DirectoryModule } from "./modules/directory/index.js";
import { DispatchModule } from "./modules/dispatch/index.js";
import { FinanceModule, LedgerEventHandler } from "./modules/finance/index.js";
import { FleetModule } from "./modules/fleet/index.js";
import { IdentityModule } from "./modules/identity/index.js";
import { NetworkModule } from "./modules/network/index.js";
import { NoteModule } from "./modules/note/index.js";
import { NotificationEventHandler, NotificationModule } from "./modules/notification/index.js";
import { PickupModule } from "./modules/pickup/index.js";
import { PlatformModule, REPLAY_HANDLERS } from "./modules/platform/index.js";
import { PickupScanEventHandler, ShipmentModule } from "./modules/shipment/index.js";
import { TrackingModule } from "./modules/tracking/index.js";
import { AppConfigModule } from "./shared/config/config.module.js";
import { AppConfigService } from "./shared/config/index.js";
import { CryptoModule } from "./shared/crypto/crypto.module.js";
import { MoneyModule } from "./shared/money/money.module.js";
import { ValkeyModule } from "./shared/valkey/valkey.module.js";
import { DatabaseModule } from "./shared/database/database.module.js";

/**
 * Application root.
 *
 * Domain modules are registered here as they are built, in the layer order
 * defined in docs/04-context-map.md. Boundary enforcement lives in ESLint
 * (`pnpm lint:rules`), not in this file.
 */
@Module({
  imports: [
    AppConfigModule,
    CryptoModule,
    DatabaseModule,
    MoneyModule,
    // ⚠️ REQUIRED even though ValkeyModule is @Global(). Global means other
    // modules need not re-import it — NOT that it registers itself. Without this
    // line nothing provides VALKEY_CLIENT, and `tracking` (presence, realtime
    // fan-out) fails to resolve, so the API does not boot at all.
    ValkeyModule,
    PlatformModule,
    IdentityModule,
    DirectoryModule,
    NetworkModule,
    FleetModule,
    ShipmentModule,
    PickupModule,
    CustodyModule,
    DispatchModule,
    FinanceModule,
    TrackingModule,
    ComplaintModule,
    NoteModule,
    NotificationModule,
    LoggerModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        pinoHttp: {
          level: config.get("LOG_LEVEL"),
          // Human-readable logs locally; structured JSON everywhere else, because
          // production logs are parsed by machines, not read by people.
          //
          // Spread conditionally rather than assigning `undefined`: under
          // `exactOptionalPropertyTypes` an explicit `undefined` is not the same
          // as an absent property, and pino's types reject it.
          ...(config.isProduction
            ? {}
            : {
                transport: {
                  target: "pino-pretty",
                  options: { singleLine: true, translateTime: "HH:MM:ss.l" },
                },
              }),
          /**
           * Correlation id for every request. Asynchronous event fan-out is
           * undebuggable without it (docs/09-infrastructure.md §7).
           *
           * ⚠️ Minted by Fastify's own `genReqId` in `createFastifyAdapter`, and
           * only observed here. A `genReqId` at this layer returning something
           * different is SILENTLY IGNORED on Fastify — the adapter has already
           * assigned `request.id` and pino logs whatever it finds. That is how
           * `req-7` reached a UUID column and 500'd every audited endpoint while
           * a perfectly good UUID generator sat here doing nothing.
           */
          genReqId: (req) => (typeof req.id === "string" ? req.id : crypto.randomUUID()),
          // PII must never reach the logs (docs/07-security-architecture.md §6.3).
          redact: {
            paths: [
              "req.headers.authorization",
              "req.headers.cookie",
              "req.headers['x-api-key']",
              "req.body.password",
              "req.body.token",
              "req.body.recipientPhone",
              "req.body.contactPhone",
              "req.body.phone",
              "res.headers['set-cookie']",
            ],
            censor: "[redacted]",
          },
          customProps: () => ({ service: config.get("OTEL_SERVICE_NAME") }),
        },
      }),
    }),
  ],
  providers: [
    /**
     * The handlers the dead-letter admin path may replay through.
     *
     * ⚠️ Bound HERE rather than in each module, and deliberately separate from
     * `EVENT_HANDLER` — that token is single-valued and belongs to the worker's
     * stream consumer. This one is a list, and it exists so an operator can
     * replay a poison event from the API where the admin surface lives.
     *
     * The API does NOT consume the stream; these handlers only ever run when
     * someone explicitly presses replay. Adding a consumer means adding it to
     * this list, or replay will report that no handler is registered — which is
     * an honest failure rather than a silent one.
     */
    {
      provide: REPLAY_HANDLERS,
      inject: [NotificationEventHandler, PickupScanEventHandler, LedgerEventHandler],
      useFactory: (
        notification: NotificationEventHandler,
        pickupScan: PickupScanEventHandler,
        ledger: LedgerEventHandler,
      ) => [notification, pickupScan, ledger],
    },
  ],
})
export class AppModule {}
