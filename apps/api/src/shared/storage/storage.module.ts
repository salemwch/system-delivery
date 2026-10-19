import { Global, Module } from "@nestjs/common";

import { AppConfigModule } from "../config/config.module.js";
import { AppConfigService } from "../config/config.service.js";
import { MALWARE_SCANNER, PassThroughMalwareScanner } from "./malware-scanner.js";
import { OBJECT_STORAGE } from "./object-storage.js";
import type { ObjectStorage } from "./object-storage.js";
import { S3ObjectStorage } from "./s3-object-storage.js";

/**
 * Provides the process-wide {@link ObjectStorage}, built once from the
 * validated `S3_*` settings. Global, like CryptoModule, and for the same reason
 * not re-exported from the barrel: it imports AppConfigModule, whose evaluation
 * validates the environment eagerly.
 */
@Global()
@Module({
  imports: [AppConfigModule],
  providers: [
    {
      provide: OBJECT_STORAGE,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): ObjectStorage =>
        new S3ObjectStorage({
          endpoint: config.get("S3_ENDPOINT"),
          region: config.get("S3_REGION"),
          bucket: config.get("S3_BUCKET"),
          accessKeyId: config.get("S3_ACCESS_KEY_ID"),
          secretAccessKey: config.get("S3_SECRET_ACCESS_KEY"),
          forcePathStyle: config.get("S3_FORCE_PATH_STYLE"),
        }),
    },
    // Pass-through by decision (2026-10-19); see malware-scanner.ts.
    { provide: MALWARE_SCANNER, useClass: PassThroughMalwareScanner },
  ],
  exports: [OBJECT_STORAGE, MALWARE_SCANNER],
})
export class StorageModule {}
