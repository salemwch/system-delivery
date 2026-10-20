import * as Haptics from "expo-haptics";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";

import { fill } from "../../core/i18n";
import type { MessageKey } from "../../core/i18n";
import { mapsUrl, telUrl, whatsappUrl } from "../../core/links";
import { localScans } from "../../platform/outbox-store";
import { record, useField } from "../../services/field";
import { pickupDetail } from "../../services/pickups";
import type { PickupDetail } from "../../services/pickups";
import { newId } from "../../services/runtime";
import { BackHeader } from "../../ui/back-header";
import { clock } from "../../ui/format";
import { useI18n } from "../../ui/i18n-context";
import {
  Banner,
  Button,
  Card,
  Chip,
  EmptyState,
  Icon,
  IconAction,
  Screen,
  SectionTitle,
} from "../../ui/kit";
import { colors, radius, space, type } from "../../ui/theme";

const OUTCOMES = [
  "MERCHANT_NOT_READY",
  "NO_PARCELS_AVAILABLE",
  "MERCHANT_CANCELLED",
  "ADDRESS_ISSUE",
  "DRIVER_FAILED",
] as const;
type Outcome = (typeof OUTCOMES)[number];
const OUTCOME_LABEL: Readonly<Record<Outcome, MessageKey>> = {
  MERCHANT_NOT_READY: "outcomeMERCHANT_NOT_READY",
  NO_PARCELS_AVAILABLE: "outcomeNO_PARCELS_AVAILABLE",
  MERCHANT_CANCELLED: "outcomeMERCHANT_CANCELLED",
  ADDRESS_ISSUE: "outcomeADDRESS_ISSUE",
  DRIVER_FAILED: "outcomeDRIVER_FAILED",
};

/**
 * One collection at a merchant: who to call, where (from the pickup's stop on
 * today's route), the parcels expected and scanned, then "collected" and,
 * at the hub, "dropped". Scans and both confirmations go through the outbox:
 * a basement with no signal does not stop a pickup.
 */
export default function PickupScreen() {
  const { t, locale } = useI18n();
  const { id } = useLocalSearchParams<{ id: string }>();
  const field = useField();
  const [detail, setDetail] = useState<PickupDetail | null | undefined>(undefined);
  const [local, setLocal] = useState<readonly string[]>([]);
  const [askOutcome, setAskOutcome] = useState(false);

  useFocusEffect(
    useCallback(() => {
      if (id === undefined) return;
      void pickupDetail(id).then(setDetail, () => setDetail(null));
      void localScans(id).then(setLocal);
    }, [id]),
  );

  if (detail === undefined)
    return (
      <Screen>
        <BackHeader title={t.tabPickups} />
      </Screen>
    );
  if (detail === null || id === undefined) {
    return (
      <Screen>
        <BackHeader title={t.tabPickups} />
        <EmptyState icon="package-variant-remove" title={t.pickupsEmpty} />
      </Screen>
    );
  }

  const { pickup, parcels } = detail;
  const queued = field.actions.filter((a) => a.subjectId === pickup.id && a.state !== "REFUSED");
  const collected =
    pickup.status === "COLLECTED" || queued.some((a) => a.kind === "PICKUP_COLLECT");
  const completed =
    pickup.status === "COMPLETED" || queued.some((a) => a.kind === "PICKUP_COMPLETE");
  const serverScanned = new Set(
    (parcels?.data ?? [])
      .filter((p) => p.scanStatus === "SCANNED")
      .map((p) => p.trackingNumber.toUpperCase()),
  );
  const scannedCodes = new Set([...serverScanned, ...local.map((c) => c.toUpperCase())]);
  const total = parcels?.summary.total ?? pickup.estimatedParcelCount;
  const stop = field.todayManifests
    .flatMap((m) => m.stops)
    .find((s) => s.id === pickup.assignedRouteStopId);
  const place =
    stop === undefined
      ? null
      : {
          latitude: stop.latitude,
          longitude: stop.longitude,
          label: [stop.address?.line1, stop.address?.city].filter(Boolean).join(", ") || null,
        };
  const maps = place === null ? null : mapsUrl(place);
  const whatsapp = whatsappUrl(pickup.contactPhone);

  const confirm = async (outcome: Outcome | null) => {
    await record({
      id: newId(),
      kind: "PICKUP_COLLECT",
      subjectId: pickup.id,
      payload: outcome === null ? {} : { outcomeReason: outcome },
    });
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setAskOutcome(false);
  };

  const footer =
    completed || pickup.status === "CANCELLED" ? undefined : collected ? (
      <Button
        label={t.completePickup}
        icon="warehouse"
        onPress={() =>
          void record({ id: newId(), kind: "PICKUP_COMPLETE", subjectId: pickup.id, payload: {} })
        }
      />
    ) : (
      <View style={{ flexDirection: "row", gap: space.md }}>
        <View style={{ flex: 1 }}>
          <Button
            label={t.collectPickup}
            icon="check"
            variant="secondary"
            onPress={() => (scannedCodes.size === 0 ? setAskOutcome(true) : void confirm(null))}
          />
        </View>
        <View style={{ flex: 1.2 }}>
          <Button
            label={t.scanParcels}
            icon="barcode-scan"
            onPress={() =>
              router.push({ pathname: "/scan", params: { mode: "pickup", pickupId: pickup.id } })
            }
          />
        </View>
      </View>
    );

  return (
    <Screen edges={["top", "bottom"]} {...(footer === undefined ? {} : { footer })}>
      <BackHeader title={pickup.code} />
      <Card>
        <View style={pd.head}>
          <View style={pd.icon}>
            <Icon name="storefront-outline" color={colors.brand} size={26} />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={type.title} numberOfLines={2}>
              {pickup.merchantName ?? pickup.contactName}
            </Text>
            <Text style={type.caption}>
              {fill(t.pickupWindow, {
                from: clock(pickup.requestedWindowFrom, locale),
                to: clock(pickup.requestedWindowTo, locale),
              })}
            </Text>
          </View>
          <Chip
            tone={completed ? "success" : collected ? "warning" : "brand"}
            label={completed ? t.pickupCOMPLETED : collected ? t.pickupCOLLECTED : t.pickupASSIGNED}
          />
        </View>
        {stop?.address?.line1 ? (
          <Text style={type.body}>
            {[stop.address.line1, stop.address.city].filter(Boolean).join(", ")}
          </Text>
        ) : null}
        {pickup.notes ? <Banner tone="info" icon="note-text-outline" text={pickup.notes} /> : null}
        <View style={pd.actions}>
          <IconAction
            icon="phone"
            label={t.call}
            onPress={() => void Linking.openURL(telUrl(pickup.contactPhone))}
          />
          {whatsapp === null ? null : (
            <IconAction
              icon="whatsapp"
              label={t.whatsapp}
              onPress={() => void Linking.openURL(whatsapp)}
            />
          )}
          {maps === null ? null : (
            <IconAction
              icon="google-maps"
              label={t.maps}
              onPress={() => void Linking.openURL(maps)}
            />
          )}
        </View>
        <Text style={type.caption}>
          {t.contact}: {pickup.contactName}
        </Text>
      </Card>

      <Card>
        <Text style={type.label}>{t.pickupScanned.toUpperCase()}</Text>
        <Text style={pd.count}>
          {scannedCodes.size}
          <Text style={pd.total}> / {total}</Text>
        </Text>
        {/* Scanned vs left as two flex weights: a ratio, no percentage arithmetic. */}
        <View style={pd.bar}>
          <View style={[pd.fill, { flex: Math.min(scannedCodes.size, total) }]} />
          <View style={{ flex: Math.max(total - scannedCodes.size, 0) }} />
        </View>
      </Card>

      {askOutcome ? (
        <Card>
          <Text style={type.heading}>{t.outcomeTitle}</Text>
          {OUTCOMES.map((outcome) => (
            <Pressable
              key={outcome}
              accessibilityRole="button"
              onPress={() => void confirm(outcome)}
              style={pd.outcome}
            >
              <Text style={[type.body, { flex: 1 }]}>{t[OUTCOME_LABEL[outcome]]}</Text>
              <Icon name="chevron-right" color={colors.muted} />
            </Pressable>
          ))}
        </Card>
      ) : null}

      {parcels === null ? null : (
        <>
          <SectionTitle>{fill(t.expectedParcels, { n: parcels.data.length })}</SectionTitle>
          <Card>
            {parcels.data.map((p) => {
              const done = scannedCodes.has(p.trackingNumber.toUpperCase());
              return (
                <View key={p.shipmentId} style={pd.parcel}>
                  <Icon
                    name={done ? "check-circle" : "checkbox-blank-circle-outline"}
                    color={done ? colors.success : colors.muted}
                    size={20}
                  />
                  <Text style={[type.body, { flex: 1, fontVariant: ["tabular-nums"] }]}>
                    {p.trackingNumber}
                  </Text>
                </View>
              );
            })}
          </Card>
        </>
      )}
    </Screen>
  );
}

const pd = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
  icon: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    backgroundColor: colors.brandSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  actions: { flexDirection: "row", justifyContent: "space-around" },
  count: { fontSize: 36, fontWeight: "800", color: colors.ink, fontVariant: ["tabular-nums"] },
  total: { fontSize: 20, fontWeight: "700", color: colors.muted },
  bar: {
    flexDirection: "row",
    height: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.line,
    overflow: "hidden",
  },
  fill: { height: 8, borderRadius: radius.pill, backgroundColor: colors.brand },
  outcome: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 52,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  parcel: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 40 },
});
