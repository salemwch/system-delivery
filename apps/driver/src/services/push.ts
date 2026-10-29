import * as Notifications from "expo-notifications";

import { registerDeviceToken } from "../core/endpoints";
import { recordLastError } from "../platform/database";
import { api } from "./runtime";

/**
 * Push notification registration and handling (docs/09 §3.2).
 *
 * expo-notifications retrieves the FCM device token from Google Play
 * Services; the app sends it to the backend via `POST /v1/drivers/me/
 * device-token`, which stores it on the driver row. Dispatch then carries the
 * token in `route.published` / `shipment.assigned` payloads so the FCM
 * provider can reach the handset.
 *
 * Sent on every shift start, and again whenever Play Services rotates the
 * token — a stale token is a driver who silently stops getting pushes. The
 * token outlives a shift on purpose: a route is often published the evening
 * before. It is cleared on sign-out, because a phone handed to a colleague
 * must not keep receiving the previous driver's route.
 */

Notifications.setNotificationHandler({
  handleNotification: () =>
    Promise.resolve({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
});

let rotation: ReturnType<typeof Notifications.addPushTokenListener> | null = null;

export async function ensurePushRegistered(): Promise<void> {
  try {
    const { status: existing } = await Notifications.getPermissionsAsync();
    let granted = String(existing) === "granted";
    if (!granted) {
      const { status } = await Notifications.requestPermissionsAsync();
      granted = String(status) === "granted";
    }
    if (!granted) return;

    await Notifications.setNotificationChannelAsync("delivery", {
      name: "Delivery updates",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#1a73e8",
    });

    const tokenData = await Notifications.getDevicePushTokenAsync();
    if (typeof tokenData.data !== "string") return;
    await sendToken(tokenData.data);

    rotation ??= Notifications.addPushTokenListener((next) => {
      if (typeof next.data !== "string") return;
      void sendToken(next.data);
    });
  } catch (error) {
    // Best-effort: no push for this session, recorded for the diagnostics
    // screen. The next shift start retries.
    await recordLastError("push", error);
  }
}

/** Clears the token server-side. Called on sign-out, while the session is still valid. */
export async function unregisterPush(): Promise<void> {
  rotation?.remove();
  rotation = null;
  await sendToken(null);
}

async function sendToken(token: string | null): Promise<void> {
  try {
    await registerDeviceToken(await api(), token);
  } catch (error) {
    // Offline at sign-out leaves the old token on the row until the next
    // driver on this phone registers theirs. Recorded, never blocking.
    await recordLastError("push", error);
  }
}
