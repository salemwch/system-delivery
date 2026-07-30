import { Global, Module } from "@nestjs/common";

import { CurrencyService } from "./currency.service.js";

/**
 * Provides the process-wide {@link CurrencyService}.
 *
 * Global for the same reason as the database and cipher modules: money formatting
 * is a cross-cutting convention, and every module that displays an amount needs
 * the exponent. Being a single provider instance is also what makes the
 * process-lifetime exponent cache worth having — one instance per importing module
 * would be one cache each.
 */
@Global()
@Module({
  providers: [CurrencyService],
  exports: [CurrencyService],
})
export class MoneyModule {}
