import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ApiError } from "../core/api";
import { currentShift, endShift, plannedVehicle, startShift } from "../core/endpoints";
import type { CurrentShift } from "../core/endpoints";
import type { BatteryState } from "../core/sampling";
import {
  batteryState,
  isBatteryOptimised,
  isUpdating,
  openBatterySettings,
  permissions,
} from "../platform/device";
import type { Permissions } from "../platform/device";
import { deviceId, secureSessions } from "../platform/secure";
import { api } from "../services/runtime";
import {
  diagnostics,
  startTracking,
  stopTracking,
  trackingShift,
  uploadIfDue,
} from "../services/tracker";
import type { Diagnostics } from "../services/tracker";
import { Button } from "../ui/button";
import { useI18n } from "../ui/i18n-context";
import { styles } from "../ui/theme";

/** Refresh cadence while the screen is open; the background task runs regardless. */
const REFRESH_MS = 5_000;

interface ViewState {
  readonly server: CurrentShift | null;
  readonly offline: boolean;
  readonly perms: Permissions;
  readonly battery: BatteryState;
  readonly optimised: boolean;
  readonly updating: boolean;
  readonly diag: Diagnostics;
}

/**
 * The driver's shift: start and end it, and see that tracking really works
 * (docs/01 4.12, battery diagnostics). Every number on this screen is what the
 * field test needs a driver to be able to read out over the phone.
 */
export default function Shift() {
  const { t, locale } = useI18n();
  const [state, setState] = useState<ViewState | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const loading = useRef(false);

  const notification = useMemo(() => ({ title: t.tracking, body: t.shiftOpen }), [t]);

  const refresh = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      let server: CurrentShift | null = null;
      let offline = false;
      try {
        server = await currentShift(await api());
      } catch (failure) {
        if (failure instanceof ApiError && failure.status === 401) {
          router.replace("/sign-in");
          return;
        }
        offline = true;
      }
      const perms = await permissions();
      // Collection follows the server's shift, both ways (tracker.ts).
      if (server !== null) {
        const tracked = await trackingShift();
        if (server.shift !== null && perms.background && tracked !== server.shift.id) {
          await startTracking(server.shift.id, notification);
        } else if (server.shift === null && tracked !== null) {
          await uploadIfDue(true);
          await stopTracking();
        }
      }
      await uploadIfDue(false);
      setState({
        server,
        offline,
        perms,
        battery: await batteryState(),
        optimised: await isBatteryOptimised(),
        updating: await isUpdating(),
        diag: await diagnostics(),
      });
    } finally {
      loading.current = false;
    }
  }, [notification]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    try {
      await action();
    } catch (failure) {
      setNotice(failure instanceof ApiError && failure.transient ? t.offline : t.tryAgain);
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const begin = () =>
    run(async () => {
      if (state === null || state.server === null) return;
      const client = await api();
      const vehicleId = await plannedVehicle(client, await deviceId());
      if (vehicleId === null) {
        setNotice(t.noRoute);
        return;
      }
      const shift = await startShift(client, state.server.driverId, vehicleId);
      await startTracking(shift.id, notification);
    });

  const finish = () =>
    run(async () => {
      const shift = state?.server?.shift ?? null;
      if (shift === null) return;
      // Upload first: the server accepts location only while the shift is open.
      await uploadIfDue(true);
      await endShift(await api(), shift.id);
      await stopTracking();
    });

  const signOut = () =>
    run(async () => {
      await uploadIfDue(true);
      await stopTracking();
      await secureSessions.clear();
      router.replace("/sign-in");
    });

  const time = (ms: number | null) =>
    ms === null
      ? t.never
      : new Date(ms).toLocaleTimeString(locale === "ar" ? "ar-TN" : `${locale}-TN`);

  const open = state?.server?.shift ?? null;
  const motionLabel =
    state === null
      ? ""
      : { MOVING: t.moving, SLOW: t.slow, STATIONARY: t.stationary }[state.diag.motion];

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>{open === null ? t.shiftNone : t.shiftOpen}</Text>
        {state?.offline === true ? <Text style={styles.warning}>{t.offline}</Text> : null}
        {notice === null ? null : <Text style={styles.warning}>{notice}</Text>}

        {open === null ? (
          <Button
            label={t.startShift}
            onPress={() => void begin()}
            busy={busy}
            disabled={state === null || state.server === null}
          />
        ) : (
          <Button label={t.endShift} onPress={() => void finish()} busy={busy} variant="danger" />
        )}

        {state === null ? null : (
          <View style={styles.card}>
            <Text style={styles.label}>{t.diagnostics}</Text>
            <Line label={t.tracking} value={state.updating ? t.granted : t.notTracking} />
            <Line
              label={t.backgroundPermission}
              value={state.perms.background ? t.granted : t.missing}
            />
            <Line
              label={t.battery}
              value={`${state.battery.percent === null ? "?" : String(state.battery.percent)} %${state.battery.charging ? ` · ${t.charging}` : ""}`}
            />
            <Line label={t.samplingMode} value={motionLabel} />
            <Line label={t.queued} value={String(state.diag.queued)} />
            <Line label={t.lastFix} value={time(state.diag.lastFixAt)} />
            <Line label={t.lastUpload} value={time(state.diag.lastUploadAt)} />
            {state.optimised ? (
              <>
                <Text style={styles.warning}>{t.batteryOptimised}</Text>
                <Button
                  label={t.fixBattery}
                  onPress={() => void openBatterySettings()}
                  variant="secondary"
                />
              </>
            ) : (
              <Text style={styles.muted}>{t.batteryExempt}</Text>
            )}
            {state.perms.background ? null : (
              <Button
                label={t.openSettings}
                onPress={() => router.push("/disclosure")}
                variant="secondary"
              />
            )}
          </View>
        )}

        <Button
          label={t.signOut}
          onPress={() => void signOut()}
          variant="secondary"
          disabled={busy}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

function Line({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.muted}>{label}</Text>
      <Text style={styles.body}>{value}</Text>
    </View>
  );
}
