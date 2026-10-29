import Constants from "expo-constants";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { driverStats } from "../../core/field-endpoints";
import type { DriverStats } from "../../core/field-endpoints";
import { fill } from "../../core/i18n";
import type { MessageKey } from "../../core/i18n";
import type { ActionKind, OutboxAction } from "../../core/outbox";
import type { BatteryState } from "../../core/sampling";
import {
  batteryState,
  isBatteryOptimised,
  openBatterySettings,
  permissions,
} from "../../platform/device";
import type { Permissions } from "../../platform/device";
import { dismiss, unsafeToForget, wipeFieldData } from "../../platform/outbox-store";
import { secureSessions } from "../../platform/secure";
import { reload, resetField, syncNow, useField } from "../../services/field";
import { unregisterPush } from "../../services/push";
import { api } from "../../services/runtime";
import { diagnostics, stopTracking, uploadIfDue } from "../../services/tracker";
import type { Diagnostics } from "../../services/tracker";
import { clock, percent } from "../../ui/format";
import { useI18n } from "../../ui/i18n-context";
import { Banner, Button, Card, Chip, Icon, ListRow, Screen, SectionTitle } from "../../ui/kit";
import type { IconName } from "../../ui/kit";
import { colors, radius, space, type } from "../../ui/theme";

const KIND_LABEL: Readonly<Record<ActionKind, MessageKey>> = {
  DELIVERED: "kindDELIVERED",
  FAILED: "kindFAILED",
  RETURN_COMPLETED: "kindRETURN_COMPLETED",
  ADDRESS_CORRECTED: "kindADDRESS_CORRECTED",
  PICKUP_SCAN: "kindPICKUP_SCAN",
  PICKUP_COLLECT: "kindPICKUP_COLLECT",
  PICKUP_COMPLETE: "kindPICKUP_COMPLETE",
};

interface Device {
  readonly perms: Permissions;
  readonly battery: BatteryState;
  readonly optimised: boolean;
  readonly diag: Diagnostics;
}

/**
 * The driver's own record (performance), what the phone still has to send
 * (and what the server refused, with the reason), the tracking diagnostics a
 * field test reads out over the phone, and signing out, which is refused
 * while anything recorded is still on the phone only.
 */
export default function Profile() {
  const { t, locale } = useI18n();
  const field = useField();
  const [stats, setStats] = useState<DriverStats | null>(null);
  const [device, setDevice] = useState<Device | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      void (async () => {
        const [perms, battery, optimised, diag] = await Promise.all([
          permissions(),
          batteryState(),
          isBatteryOptimised(),
          diagnostics(),
        ]);
        setDevice({ perms, battery, optimised, diag });
      })();
    }, []),
  );

  const driverId = field.shift?.driverId ?? null;
  useFocusEffect(
    useCallback(() => {
      if (driverId === null) return;
      void api()
        .then((client) => driverStats(client, driverId))
        .then(setStats, () => undefined);
    }, [driverId]),
  );

  const pending = field.actions.filter((a) => a.state === "PENDING");
  const attention = field.actions.filter((a) => a.state === "ESCALATED" || a.state === "REFUSED");

  const signOut = async () => {
    // Recorded work never leaves with the session: send it, or refuse.
    await syncNow().catch(() => undefined);
    const count = await unsafeToForget();
    if (count > 0) {
      setNotice(fill(t.signOutBlocked, { n: count }));
      return;
    }
    await uploadIfDue(true);
    await stopTracking();
    await unregisterPush();
    await wipeFieldData();
    await secureSessions.clear();
    resetField();
    router.replace("/sign-in");
  };

  return (
    <Screen>
      <Text style={type.title}>{t.profileTitle}</Text>

      {stats === null ? null : (
        <>
          <SectionTitle>{t.statsTitle}</SectionTitle>
          <View style={pf.stats}>
            <Stat
              icon="package-variant-closed-check"
              value={String(stats.totalDeliveries)}
              label={t.deliveries}
            />
            <Stat icon="target" value={percent(stats.deliveryRate)} label={t.successRate} />
            <Stat
              icon="clock-check-outline"
              value={stats.onTimeRate === null ? "–" : percent(stats.onTimeRate)}
              label={t.onTime}
            />
          </View>
        </>
      )}

      <SectionTitle
        action={
          <Button
            label={t.syncNow}
            icon="sync"
            variant="ghost"
            compact
            busy={field.syncing}
            onPress={() => void syncNow().catch(() => undefined)}
          />
        }
      >
        {t.outboxTitle}
      </SectionTitle>
      <Card>
        {pending.length === 0 && attention.length === 0 ? (
          <ListRow
            title={t.outboxEmpty}
            leading={<Icon name="cloud-check-outline" color={colors.success} />}
          />
        ) : null}
        {pending.length === 0 ? null : (
          <ListRow
            title={fill(t.waitingToSend, { n: pending.length })}
            subtitle={
              field.offline
                ? t.offline
                : field.lastSyncAt === null
                  ? t.notSynced
                  : fill(t.syncedAt, { time: clock(field.lastSyncAt, locale) })
            }
            leading={<Icon name="cloud-upload-outline" color={colors.warning} />}
          />
        )}
        {attention.map((action) => (
          <AttentionRow key={action.id} action={action} />
        ))}
      </Card>

      {device === null ? null : (
        <>
          <SectionTitle>{t.diagnostics}</SectionTitle>
          <Card>
            <Line
              label={t.tracking}
              value={
                field.shift?.shift === null || field.shift === null ? t.notTracking : t.shiftOpen
              }
            />
            <Line
              label={t.backgroundPermission}
              value={device.perms.background ? t.granted : t.missing}
            />
            <Line
              label={t.battery}
              value={`${device.battery.percent === null ? "?" : String(device.battery.percent)} %${device.battery.charging ? ` · ${t.charging}` : ""}`}
            />
            <Line
              label={t.samplingMode}
              value={
                { MOVING: t.moving, SLOW: t.slow, STATIONARY: t.stationary }[device.diag.motion]
              }
            />
            <Line label={t.queued} value={String(device.diag.queued)} />
            <Line
              label={t.lastFix}
              value={
                device.diag.lastFixAt === null ? t.never : clock(device.diag.lastFixAt, locale)
              }
            />
            <Line
              label={t.lastUpload}
              value={
                device.diag.lastUploadAt === null
                  ? t.never
                  : clock(device.diag.lastUploadAt, locale)
              }
            />
            {device.optimised ? (
              <>
                <Banner
                  tone="warning"
                  icon="battery-alert-variant-outline"
                  text={t.batteryOptimised}
                />
                <Button
                  label={t.fixBattery}
                  icon="battery-heart-outline"
                  variant="secondary"
                  onPress={() => void openBatterySettings()}
                />
              </>
            ) : (
              <Chip tone="success" icon="battery-check-outline" label={t.batteryExempt} />
            )}
            {device.perms.background ? null : (
              <Button
                label={t.openSettings}
                icon="map-marker-radius-outline"
                variant="secondary"
                onPress={() => router.push("/disclosure")}
              />
            )}
          </Card>
        </>
      )}

      {notice === null ? null : <Banner tone="danger" icon="cloud-alert" text={notice} />}
      <Button label={t.signOut} icon="logout" variant="secondary" onPress={() => void signOut()} />
      <Text style={[type.caption, { textAlign: "center" }]}>
        {t.appName} {Constants.expoConfig?.version ?? ""}
      </Text>
    </Screen>
  );
}

function AttentionRow({ action }: { readonly action: OutboxAction }) {
  const { t, locale } = useI18n();
  const escalated = action.state === "ESCALATED";
  return (
    <View style={pf.attention}>
      <Icon
        name={escalated ? "alert-octagon-outline" : "close-octagon-outline"}
        color={colors.danger}
      />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={type.heading}>
          {t[KIND_LABEL[action.kind]]} · {clock(action.createdAt, locale)}
        </Text>
        <Text style={[type.caption, { color: colors.danger }]}>
          {escalated ? t.escalatedItems : t.refusedItems}
        </Text>
        {action.code === null ? null : <Text style={type.caption}>{action.code}</Text>}
      </View>
      <Button
        label={t.dismiss}
        variant="ghost"
        compact
        onPress={() => {
          void dismiss(action.id).then(reload);
        }}
      />
    </View>
  );
}

function Stat({
  icon,
  value,
  label,
}: {
  readonly icon: IconName;
  readonly value: string;
  readonly label: string;
}) {
  return (
    <View style={pf.stat}>
      <Icon name={icon} color={colors.brand} />
      <Text style={pf.statValue}>{value}</Text>
      <Text style={type.caption} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

function Line({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <View style={pf.line}>
      <Text style={type.caption}>{label}</Text>
      <Text style={[type.body, { fontWeight: "600" }]}>{value}</Text>
    </View>
  );
}

const pf = StyleSheet.create({
  stats: { flexDirection: "row", gap: space.md },
  stat: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: space.md,
    gap: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  },
  statValue: { fontSize: 22, fontWeight: "800", color: colors.ink, fontVariant: ["tabular-nums"] },
  attention: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingVertical: space.sm,
  },
  line: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    minHeight: 36,
    gap: space.md,
  },
});
