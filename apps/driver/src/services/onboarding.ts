import { readMeta, writeMeta } from "../platform/database";

/** The introduction is shown once per install (not per login: the phone is the driver's). */
const ONBOARDED = "app.onboarded";

export async function isOnboarded(): Promise<boolean> {
  return (await readMeta(ONBOARDED)) === "1";
}

export function markOnboarded(): Promise<void> {
  return writeMeta(ONBOARDED, "1");
}

/**
 * "Not now" on the location disclosure is a real choice: the launch stops
 * insisting, and the Today screen offers it again instead.
 */
const DISCLOSURE_DECLINED = "app.disclosureDeclined";

export async function disclosureDeclined(): Promise<boolean> {
  return (await readMeta(DISCLOSURE_DECLINED)) === "1";
}

export function setDisclosureDeclined(declined: boolean): Promise<void> {
  return writeMeta(DISCLOSURE_DECLINED, declined ? "1" : "0");
}
