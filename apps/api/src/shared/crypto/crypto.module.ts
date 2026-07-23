import { Global, Module } from "@nestjs/common";

import { AppConfigModule } from "../config/config.module.js";
import { AppConfigService } from "../config/config.service.js";
import { FieldCipher } from "./field-cipher.js";
import { FIELD_CIPHER } from "./crypto.tokens.js";

/**
 * Provides the process-wide {@link FieldCipher}, built once from the validated
 * `FIELD_ENCRYPTION_KEY`. Global so any module can inject `FIELD_CIPHER` without
 * re-importing it, the same way the database and valkey clients are shared.
 *
 * The key is read here and nowhere else; the cipher itself never touches config.
 */
@Global()
@Module({
  imports: [AppConfigModule],
  providers: [
    {
      provide: FIELD_CIPHER,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): FieldCipher =>
        new FieldCipher(Buffer.from(config.get("FIELD_ENCRYPTION_KEY"), "base64")),
    },
  ],
  exports: [FIELD_CIPHER],
})
export class CryptoModule {}
