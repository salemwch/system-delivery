/* eslint-env node */
/**
 * Detox E2E configuration (docs/08 §8.4).
 *
 * Targets the physical Oppo A9 (CPH1937, Android 11) via `android.attached`.
 * The device must be connected via USB with `adb devices` listing it.
 *
 * Usage:
 *   pnpm e2e                         # all tests on the attached device
 *   pnpm e2e -- -t "login"           # single test by name
 */

/** @type {import('detox').DetoxConfig} */
module.exports = {
  testRunner: {
    args: {
      config: "e2e/jest.config.js",
      _: ["e2e"],
    },
    jest: {
      setupTimeout: 120000,
    },
  },
  apps: {
    "android.debug": {
      type: "android.apk",
      binaryPath: "android/app/build/outputs/apk/debug/app-debug.apk",
      build:
        "cd android && ./gradlew assembleDebug assembleAndroidTest -DtestBuildType=debug && cd ..",
      reversePorts: [3000, 8081],
    },
  },
  devices: {
    attached: {
      type: "android.attached",
      device: { adbName: ".*" },
    },
  },
  configurations: {
    "android.att.debug": {
      device: "attached",
      app: "android.debug",
    },
  },
};
