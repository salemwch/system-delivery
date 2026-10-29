import { endShift, startShift } from "../core/endpoints";
import type { CurrentShift } from "../core/endpoints";
import { permissions } from "../platform/device";
import { refreshShift } from "./field";
import { ensurePushRegistered } from "./push";
import { api } from "./runtime";
import { startTracking, stopTracking, trackingShift, uploadIfDue } from "./tracker";
import type { Notification } from "./tracker";

/**
 * The shift, on the device: location collection follows the SERVER's shift,
 * both ways (tracker.ts). Called on every refresh of the Today screen, so a
 * shift closed from the dispatcher's board stops collection on the phone too.
 */
export async function reconcileTracking(
  shift: CurrentShift | null,
  notification: Notification,
): Promise<void> {
  if (shift === null) {
    // Offline: keep doing what we were doing; the server decides when we reach it.
    await uploadIfDue(false);
    return;
  }
  const tracked = await trackingShift();
  const granted = await permissions();
  if (shift.shift !== null && granted.background && tracked !== shift.shift.id) {
    await startTracking(shift.shift.id, notification);
  } else if (shift.shift === null && tracked !== null) {
    await uploadIfDue(true);
    await stopTracking();
  }
  await uploadIfDue(false);
}

/** Opens a shift on the van dispatch planned for today's route. */
export async function openShift(
  driverId: string,
  vehicleId: string,
  notification: Notification,
): Promise<void> {
  const shift = await startShift(await api(), driverId, vehicleId);
  if ((await permissions()).background) {
    await startTracking(shift.id, notification);
  }
  void ensurePushRegistered();
  await refreshShift();
}

/** Uploads what was captured, then closes: the server accepts points only while it is open. */
export async function closeShift(shiftId: string): Promise<void> {
  await uploadIfDue(true);
  await endShift(await api(), shiftId);
  await stopTracking();
  await refreshShift();
}
