import Constants from "expo-constants";
import { z } from "zod";

/**
 * The app's one configuration boundary: read here, validated here, nowhere
 * else (the same rule as the API's ConfigService and the web apps'
 * lib/config.ts). The value is set at build time from the EAS environment
 * (`EXPO_PUBLIC_API_URL`, eas.json profiles), never committed.
 *
 * A release build refuses plain HTTP: a driver's location, phone sessions and
 * COD figures do not cross a café's Wi-Fi in clear text.
 */
const configSchema = z.object({
  apiUrl: z
    .url()
    .transform((url) => url.replace(/\/+$/u, ""))
    .refine((url) => __DEV__ || url.startsWith("https://"), {
      message: "release builds require an https API URL",
    }),
});

export type AppConfig = z.infer<typeof configSchema>;

let cached: AppConfig | null = null;

export function appConfig(): AppConfig {
  cached ??= configSchema.parse(Constants.expoConfig?.extra ?? {});
  return cached;
}
