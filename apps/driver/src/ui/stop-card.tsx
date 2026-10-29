import { Pressable, StyleSheet, Text, View } from "react-native";

import { etaMinutes, formatDistance, haversineMetres } from "../core/geo";
import { fill } from "../core/i18n";
import type { MessageKey } from "../core/i18n";
import type { StopView } from "../core/manifest";
import { formatMoney } from "../core/money";
import { useField } from "../services/field";
import { useI18n } from "./i18n-context";
import { Chip, Icon } from "./kit";
import { colors, elevation, radius, space, type } from "./theme";

const STOP_LABEL: Readonly<Record<string, MessageKey>> = {
  DELIVERY: "stopDELIVERY",
  PICKUP: "stopPICKUP",
  HUB_LOAD: "stopHUB_LOAD",
  HUB_UNLOAD: "stopHUB_UNLOAD",
  BREAK: "stopBREAK",
};

export function stopLabelKey(stopType: string): MessageKey {
  return STOP_LABEL[stopType] ?? "stopDELIVERY";
}

/** The first line a driver reads: the street, else the recipient. */
export function stopTitle(view: StopView, fallback: string): string {
  return view.stop.address?.line1 ?? view.parcels[0]?.shipment.recipientName ?? fallback;
}

/**
 * One stop in a list: its number in the route, where, who, how many parcels,
 * the cash to collect, and whether it is done. Done stops step back (muted)
 * so the eye lands on what is left.
 */
export function StopCard({
  view,
  onPress,
  highlight = false,
  driverPosition,
}: {
  readonly view: StopView;
  readonly onPress: () => void;
  readonly highlight?: boolean;
  readonly driverPosition?: { latitude: number; longitude: number } | null;
}) {
  const { t, locale } = useI18n();
  const field = useField();
  const parcels = view.parcels.reduce((n, p) => n + p.shipment.parcelCount, 0);
  const delivered = view.parcels.filter((p) => p.state === "DELIVERED").length;
  const failed = view.parcels.filter((p) => p.state === "FAILED").length;
  const unsent = view.parcels.some((p) => p.unsent);
  const recipients = [...new Set(view.parcels.map((p) => p.shipment.recipientName))].join(", ");
  const etaEnabled = field.features["DRIVER_ETA_ENABLED"] === true;
  const eta =
    etaEnabled &&
    driverPosition !== undefined &&
    driverPosition !== null &&
    view.stop.latitude !== null &&
    view.stop.longitude !== null
      ? haversineMetres(
          driverPosition.latitude,
          driverPosition.longitude,
          view.stop.latitude,
          view.stop.longitude,
        )
      : null;

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        sc.card,
        highlight && sc.highlight,
        !view.open && sc.done,
        pressed && { opacity: 0.85 },
      ]}
    >
      <View style={[sc.seq, !view.open && { backgroundColor: colors.successSoft }]}>
        {view.open ? (
          <Text style={sc.seqText}>{view.stop.sequence}</Text>
        ) : (
          <Icon name="check" color={colors.success} size={20} />
        )}
      </View>
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={type.caption}>
          {t[stopLabelKey(view.stop.type)]}
          {view.stop.address?.city ? ` · ${view.stop.address.city}` : ""}
        </Text>
        <Text style={type.heading} numberOfLines={1}>
          {stopTitle(view, t.noAddress)}
        </Text>
        {recipients === "" ? null : (
          <Text style={type.caption} numberOfLines={1}>
            {recipients}
          </Text>
        )}
        <View style={sc.chips}>
          {parcels > 0 ? (
            <Chip icon="package-variant" label={fill(t.parcelCount, { n: parcels })} />
          ) : null}
          {view.cod.map((money) => (
            <Chip key={money.currency} tone="cash" icon="cash" label={formatMoney(money, locale)} />
          ))}
          {delivered > 0 ? (
            <Chip
              tone="success"
              icon="check-circle-outline"
              label={`${t.delivered} ${String(delivered)}`}
            />
          ) : null}
          {failed > 0 ? (
            <Chip
              tone="danger"
              icon="close-circle-outline"
              label={`${t.failed} ${String(failed)}`}
            />
          ) : null}
          {unsent ? <Chip tone="warning" icon="cloud-upload-outline" label={t.unsent} /> : null}
          {eta !== null && view.open ? (
            <Chip
              icon="map-marker-distance"
              label={fill(t.etaAway, {
                distance: formatDistance(eta),
                minutes: etaMinutes(eta),
              })}
            />
          ) : null}
        </View>
      </View>
      <Icon name="chevron-right" color={colors.muted} />
    </Pressable>
  );
}

const sc = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    ...elevation.card,
  },
  highlight: { borderColor: colors.brand, borderWidth: 2 },
  done: { opacity: 0.7 },
  seq: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    backgroundColor: colors.brandSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  seqText: { color: colors.brandDark, fontWeight: "800", fontSize: 16 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 2 },
});
