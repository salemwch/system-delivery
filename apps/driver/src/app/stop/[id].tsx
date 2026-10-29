import * as Location from "expo-location";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Linking, Pressable, Share, StyleSheet, Text, View } from "react-native";

import { etaMinutes, formatDistance, haversineMetres } from "../../core/geo";
import { shipment as fetchShipment } from "../../core/field-endpoints";
import type { ShipmentDetail } from "../../core/field-endpoints";
import { fill } from "../../core/i18n";
import type { MessageKey } from "../../core/i18n";
import { mapsUrl, telUrl, wazeUrl, whatsappUrl } from "../../core/links";
import { stopView } from "../../core/manifest";
import type { ParcelState, ParcelView, StopView } from "../../core/manifest";
import { formatMoney, isZero } from "../../core/money";
import { useField } from "../../services/field";
import { api } from "../../services/runtime";
import { BackHeader } from "../../ui/back-header";
import { useI18n } from "../../ui/i18n-context";
import { StopMap } from "../../ui/stop-map";
import {
  Button,
  Card,
  Chip,
  EmptyState,
  Icon,
  IconAction,
  Screen,
  SectionTitle,
} from "../../ui/kit";
import type { ChipTone, IconName } from "../../ui/kit";
import { stopLabelKey, stopTitle } from "../../ui/stop-card";
import { colors, radius, space, type } from "../../ui/theme";

/**
 * One stop: where it is (navigate there), who to call, and each parcel with
 * its action. Deliver is the big button; "not delivered" sits beside it.
 * Everything here works offline except the attempt counter, which is a
 * nice-to-have fetched when there is signal.
 */
export default function StopScreen() {
  const { t } = useI18n();
  const { id } = useLocalSearchParams<{ id: string }>();
  const field = useField();
  const found = findStop(field.todayManifests, id, field.pending);
  const running = field.manifests.some(
    (m) => m.routeId === found?.routeId && m.status === "IN_PROGRESS",
  );
  const details = useDetails(found?.parcels.map((p) => p.shipment.shipmentId) ?? []);
  const [driverPos, setDriverPos] = useState<{ latitude: number; longitude: number } | null>(null);

  useEffect(() => {
    void Location.getLastKnownPositionAsync().then((loc) => {
      if (loc !== null)
        setDriverPos({ latitude: loc.coords.latitude, longitude: loc.coords.longitude });
    });
  }, []);

  if (found === null) {
    return (
      <Screen>
        <BackHeader title={t.tabStops} />
        <EmptyState icon="map-marker-question-outline" title={t.stopsEmpty} />
      </Screen>
    );
  }

  const { stop } = found;
  const label = [stop.address?.line1, stop.address?.city].filter(Boolean).join(", ") || null;
  const place = { latitude: stop.latitude, longitude: stop.longitude, label };
  const maps = mapsUrl(place);
  const waze = wazeUrl(place);

  return (
    <Screen>
      <BackHeader title={`${t[stopLabelKey(stop.type)]} · ${String(stop.sequence)}`} />

      <Card>
        <View style={{ gap: 4 }}>
          <Text style={type.title}>{stopTitle(found, t.noAddress)}</Text>
          {stop.address?.city ? <Text style={type.caption}>{stop.address.city}</Text> : null}
        </View>
        {stop.address?.accessNotes ? (
          <View style={sd.notes}>
            <Icon name="information-outline" color={colors.info} size={20} />
            <View style={{ flex: 1 }}>
              <Text style={[type.label, { color: colors.info }]}>{t.accessNotes}</Text>
              <Text style={type.body}>{stop.address.accessNotes}</Text>
            </View>
          </View>
        ) : null}
        <View style={sd.actions}>
          <IconAction
            icon="google-maps"
            label={t.maps}
            onPress={() => maps !== null && void Linking.openURL(maps)}
          />
          <IconAction
            icon="waze"
            label={t.waze}
            onPress={() => waze !== null && void Linking.openURL(waze)}
          />
          {stop.addressId === null ? null : (
            <IconAction
              icon="crosshairs-gps"
              label={t.correctLocation}
              tone="neutral"
              onPress={() =>
                router.push({
                  pathname: "/correct-location",
                  params: { addressId: stop.addressId ?? "" },
                })
              }
            />
          )}
        </View>
      </Card>

      {stop.latitude !== null && stop.longitude !== null ? (
        <StopMap latitude={stop.latitude} longitude={stop.longitude} />
      ) : null}

      {field.features["DRIVER_ETA_ENABLED"] === true &&
      driverPos !== null &&
      stop.latitude !== null &&
      stop.longitude !== null
        ? (() => {
            const dist = haversineMetres(
              driverPos.latitude,
              driverPos.longitude,
              stop.latitude,
              stop.longitude,
            );
            return (
              <View style={sd.etaRow}>
                <Chip
                  icon="map-marker-distance"
                  label={fill(t.etaAway, {
                    distance: formatDistance(dist),
                    minutes: etaMinutes(dist),
                  })}
                />
                {field.features["DRIVER_SHARE_ETA_ENABLED"] === true && found.parcels.length > 0 ? (
                  <Chip
                    icon="share-variant-outline"
                    label={t.shareEta}
                    onPress={() => {
                      const tracking = found.parcels[0]?.shipment.trackingNumber ?? "";
                      const minutes = etaMinutes(dist);
                      void Share.share({
                        message: fill(t.shareEtaMessage, { tracking, minutes }),
                      });
                    }}
                  />
                ) : null}
              </View>
            );
          })()
        : null}

      <SectionTitle>{fill(t.parcelCount, { n: found.parcels.length })}</SectionTitle>
      {found.parcels.map((parcel) => (
        <ParcelCard
          key={parcel.shipment.shipmentId}
          parcel={parcel}
          detail={details[parcel.shipment.shipmentId] ?? null}
          canAct={running}
        />
      ))}
    </Screen>
  );
}

const STATE_CHIP: Readonly<
  Record<ParcelState, { tone: ChipTone; icon: IconName; label: MessageKey } | null>
> = {
  TODO: null,
  DELIVERED: { tone: "success", icon: "check-circle-outline", label: "stateDELIVERED" },
  FAILED: { tone: "danger", icon: "close-circle-outline", label: "stateFAILED" },
  RETURNED: { tone: "info", icon: "keyboard-return", label: "stateRETURNED" },
  OTHER: { tone: "neutral", icon: "minus-circle-outline", label: "stateOTHER" },
};

function ParcelCard({
  parcel,
  detail,
  canAct,
}: {
  readonly parcel: ParcelView;
  readonly detail: ShipmentDetail | null;
  readonly canAct: boolean;
}) {
  const { t, locale } = useI18n();
  const { shipment } = parcel;
  const chip = STATE_CHIP[parcel.state];
  const whatsapp = whatsappUrl(shipment.recipientPhone);
  const returnable = !parcel.unsent && shipment.status === "RETURN_PENDING";
  const params = { shipmentId: shipment.shipmentId };

  return (
    <Card>
      <View style={sd.parcelHead}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={type.heading}>{shipment.recipientName}</Text>
          <Text style={[type.caption, { fontVariant: ["tabular-nums"] }]}>
            {shipment.trackingNumber}
          </Text>
        </View>
        {chip === null ? null : <Chip tone={chip.tone} icon={chip.icon} label={t[chip.label]} />}
      </View>
      <View style={sd.chips}>
        {shipment.parcelCount > 1 ? (
          <Chip icon="package-variant" label={fill(t.parcelCount, { n: shipment.parcelCount })} />
        ) : null}
        {isZero(shipment.cod) ? null : (
          <Chip tone="cash" icon="cash" label={formatMoney(shipment.cod, locale)} />
        )}
        {detail === null ? null : (
          <Chip
            icon="history"
            label={fill(t.attempt, {
              n: detail.attemptCount + (parcel.state === "TODO" ? 1 : 0),
              max: detail.maxAttempts,
            })}
          />
        )}
        {parcel.unsent ? (
          <Chip tone="warning" icon="cloud-upload-outline" label={t.unsent} />
        ) : null}
      </View>
      <View style={sd.contact}>
        <ContactButton
          icon="phone"
          label={t.call}
          onPress={() => void Linking.openURL(telUrl(shipment.recipientPhone))}
        />
        {whatsapp === null ? null : (
          <ContactButton
            icon="whatsapp"
            label={t.whatsapp}
            onPress={() => void Linking.openURL(whatsapp)}
          />
        )}
        {detail?.recipientPhoneAlt ? (
          <ContactButton
            icon="phone-plus"
            label={detail.recipientPhoneAlt}
            onPress={() => void Linking.openURL(telUrl(detail.recipientPhoneAlt ?? ""))}
          />
        ) : null}
      </View>
      {parcel.state === "TODO" && canAct ? (
        <View style={sd.cta}>
          <View style={{ flex: 1 }}>
            <Button
              label={t.notDelivered}
              icon="close"
              variant="secondary"
              onPress={() => router.push({ pathname: "/fail/[shipmentId]", params })}
            />
          </View>
          <View style={{ flex: 1.4 }}>
            <Button
              label={t.deliver}
              icon="check-bold"
              onPress={() => router.push({ pathname: "/deliver/[shipmentId]", params })}
            />
          </View>
        </View>
      ) : null}
      {returnable ? (
        <Button
          label={t.returnHandedOver}
          icon="keyboard-return"
          variant="secondary"
          onPress={() => router.push({ pathname: "/return/[shipmentId]", params })}
        />
      ) : null}
      <Pressable
        accessibilityRole="button"
        onPress={() => router.push({ pathname: "/report", params })}
        style={sd.report}
      >
        <Icon name="alert-circle-outline" size={18} color={colors.muted} />
        <Text style={type.caption}>{t.reportProblem}</Text>
      </Pressable>
    </Card>
  );
}

function ContactButton({
  icon,
  label,
  onPress,
}: {
  readonly icon: IconName;
  readonly label: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [sd.contactButton, pressed && { opacity: 0.8 }]}
    >
      <Icon name={icon} size={18} color={colors.brand} />
      <Text style={sd.contactText} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function findStop(
  manifests: ReturnType<typeof useField>["todayManifests"],
  id: string | undefined,
  pending: ReturnType<typeof useField>["pending"],
): StopView | null {
  for (const m of manifests) {
    const stop = m.stops.find((s) => s.id === id);
    if (stop !== undefined) return stopView(m.routeId, stop, pending);
  }
  return null;
}

/** Attempt counts and the alternative phone, when there is signal. Never blocks the screen. */
function useDetails(ids: readonly string[]): Readonly<Record<string, ShipmentDetail>> {
  const [details, setDetails] = useState<Readonly<Record<string, ShipmentDetail>>>({});
  const key = ids.join(",");
  useEffect(() => {
    let alive = true;
    void (async () => {
      const client = await api();
      const results = await Promise.allSettled(
        key
          .split(",")
          .filter(Boolean)
          .map((sid) => fetchShipment(client, sid)),
      );
      if (!alive) return;
      setDetails(
        Object.fromEntries(
          results.flatMap((r) =>
            r.status === "fulfilled" ? [[r.value.id, r.value] as const] : [],
          ),
        ),
      );
    })();
    return () => {
      alive = false;
    };
  }, [key]);
  return details;
}

const sd = StyleSheet.create({
  notes: {
    flexDirection: "row",
    gap: space.md,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.infoSoft,
  },
  etaRow: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  actions: { flexDirection: "row", justifyContent: "space-around", marginTop: space.xs },
  parcelHead: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  contact: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  contactButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 40,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    backgroundColor: colors.brandSoft,
  },
  contactText: { color: colors.brandDark, fontWeight: "700", fontSize: 14 },
  cta: { flexDirection: "row", gap: space.md },
  report: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    minHeight: 36,
  },
});
