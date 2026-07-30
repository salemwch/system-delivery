/**
 * Money: integer minor units plus an ISO 4217 exponent read from data.
 *
 * `MoneyModule` is NOT re-exported here, matching `crypto/index.ts` and
 * `config/index.ts` — a barrel that pulls a `@Module` in drags its imports into
 * every consumer. Composition roots import it from ./money.module.js directly.
 */
export { formatMinorUnits, parseMinorUnits } from "./money.js";
export { CurrencyService } from "./currency.service.js";
export { currencies } from "./currency.schema.js";
export type { Currency } from "./currency.schema.js";
