import { LinearGradient } from "expo-linear-gradient";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";

import { ApiError } from "../../core/api";
import { completeRoute, startRoute } from "../../core/field-endpoints";
import { fill } from "../../core/i18n";
import {
  canComplete,
  cashCollected,
  currentRoute,
  dayProgress,
  nextStop,
} from "../../core/manifest";
import { formatMoney, remaining } from "../../core/money";
import type { Money } from "../../core/money";
import { mapsUrl } from "../../core/links";
import { permissions } from "../../platform/device";
import { handoversToday } from "../../services/cash";
import { syncNow, useField } from "../../services/field";
import { api } from "../../services/runtime";
import { closeShift, openShift, reconcileTracking } from "../../services/shift";
import { clock, greetingKey, longDate } from "../../ui/format";
import { useI18n } from "../../ui/i18n-context";
import { Banner, Button, Card, Chip, Icon, ProgressRing, Screen } from "../../ui/kit";
import type { IconName } from "../../ui/kit";
import { stopTitle } from "../../ui/stop-card";
import { colors, radius, space, type } from "../../ui/theme";

/**
 * The driver's day on one screen, built around ONE next action: start the
 * shift, start the route, go to the next stop, close the route, hand over the
 * cash. The big button is always the thing to do now, in the thumb zone.
 */
export default function Today() {
  const { t, locale } = useI18n();
  const field = useField();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [background, setBackground] = useState(true);
  const [handed, setHanded] = useState<Money[]>([]);

  const notification = useMemo(() => ({ title: t.tracking, body: t.shiftOpen }), [t]);

  useFocusEffect(
    useCallback(() => {
      void permissions().then((p) => setBackground(p.background));
      void handoversToday().then(setHanded);
    }, []),
  );

  // Collection follows the server's shift, both ways.
  useEffect(() => {
    void reconcileTracking(field.shift, notification).catch(() => undefined);
  }, [field.shift, notification]);

  const route = currentRoute(field.manifests);
  // Progress counts the whole day, completed routes included.
  const progress = dayProgress(field.todayManifests, field.pending);
  const next = nextStop(field.manifests, field.pending);
  const toHand = remaining(cashCollected(field.todayManifests, field.pending), handed);
  const unsent = field.actions.filter((a) => a.state === "PENDING").length;
  const escalated = field.actions.filter((a) => a.state === "ESCALATED").length;
  const shift = field.shift?.shift ?? null;
  const now = new Date();

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    try {
      await action();
    } catch (failure) {
      setNotice(failure instanceof ApiError && failure.transient ? t.needsNetwork : t.tryAgain);
    } finally {
      setBusy(false);
    }
  };

  const beginShift = () =>
    run(async () => {
      const driverId = field.shift?.driverId;
      const vehicleId = route?.vehicleId ?? null;
      if (driverId === undefined) throw new ApiError(0, "NETWORK", "offline");
      if (vehicleId === null) {
        setNotice(t.noRoute);
        return;
      }
      await openShift(driverId, vehicleId, notification);
    });

  const routeAction = (call: typeof startRoute) =>
    run(async () => {
      if (route === null) return;
      await call(await api(), route.routeId);
      await syncNow();
    });

  // ── The one next action ─────────────────────────────────────────────────
  let primary: ReactNode;
  if (route === null) {
    primary = (
      <Card>
        <View style={td.row}>
          <Icon
            name={progress.total > 0 ? "party-popper" : "calendar-blank-outline"}
            color={colors.brand}
            size={28}
          />
          <Text style={[type.heading, { flex: 1 }]}>
            {progress.total > 0 ? t.dayDone : t.noRoute}
          </Text>
        </View>
        {shift !== null ? (
          <Button
            label={t.endShift}
            icon="stop-circle-outline"
            variant="secondary"
            busy={busy}
            onPress={() => void run(() => closeShift(shift.id))}
          />
        ) : null}
      </Card>
    );
  } else if (shift === null) {
    primary = (
      <Card>
        <Text style={type.heading}>{t.shiftNone}</Text>
        <Button
          label={t.startShift}
          icon="play-circle-outline"
          busy={busy}
          disabled={field.shift === null}
          onPress={() => void beginShift()}
        />
      </Card>
    );
  } else if (route.status === "PUBLISHED") {
    primary = (
      <Card>
        <Text style={type.body}>{t.startRouteHint}</Text>
        <Button
          label={t.startRoute}
          icon="truck-fast-outline"
          busy={busy}
          onPress={() => void routeAction(startRoute)}
        />
      </Card>
    );
  } else if (canComplete(route, field.pending)) {
    primary = (
      <Card>
        <View style={td.row}>
          <Icon name="flag-checkered" color={colors.success} size={28} />
          <Text style={[type.heading, { flex: 1 }]}>{t.routeAllDone}</Text>
        </View>
        <Button
          label={t.completeRoute}
          icon="check-all"
          busy={busy}
          onPress={() => void routeAction(completeRoute)}
        />
      </Card>
    );
  } else if (next !== null) {
    const place = {
      latitude: next.stop.latitude,
      longitude: next.stop.longitude,
      label: [next.stop.address?.line1, next.stop.address?.city].filter(Boolean).join(", ") || null,
    };
    const url = mapsUrl(place);
    primary = (
      <Card>
        <View style={td.row}>
          <View style={td.seq}>
            <Text style={td.seqText}>{next.stop.sequence}</Text>
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={type.label}>{t.nextStop.toUpperCase()}</Text>
            <Text style={type.heading} numberOfLines={2}>
              {stopTitle(next, t.noAddress)}
            </Text>
            <Text style={type.caption} numberOfLines={1}>
              {[
                next.stop.address?.city,
                next.parcels.map((p) => p.shipment.recipientName).join(", "),
              ]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          </View>
        </View>
        <View style={td.chips}>
          {next.cod.map((money) => (
            <Chip key={money.currency} tone="cash" icon="cash" label={formatMoney(money, locale)} />
          ))}
          {next.stop.plannedArrivalAt === null ? null : (
            <Chip icon="clock-outline" label={clock(next.stop.plannedArrivalAt, locale)} />
          )}
        </View>
        <View style={td.actions}>
          <View style={{ flex: 1 }}>
            <Button
              label={t.openStop}
              icon="format-list-checks"
              variant="secondary"
              onPress={() => router.push({ pathname: "/stop/[id]", params: { id: next.stop.id } })}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              label={t.navigate}
              icon="navigation-variant"
              disabled={url === null}
              onPress={() => url !== null && void Linking.openURL(url)}
            />
          </View>
        </View>
      </Card>
    );
  } else {
    primary = null;
  }

  return (
    <Screen>
      <View style={td.header}>
        <View style={{ flex: 1 }}>
          <Text style={type.caption}>{longDate(now, locale)}</Text>
          <Text style={type.title}>{t[greetingKey(now)]}</Text>
        </View>
        <SyncPill />
      </View>

      {field.offline ? (
        <Banner
          tone="warning"
          icon="wifi-off"
          text={unsent > 0 ? `${t.offline} · ${fill(t.waitingToSend, { n: unsent })}` : t.offline}
        />
      ) : null}
      {escalated > 0 ? (
        <Pressable onPress={() => router.push("/(tabs)/profile")}>
          <Banner
            tone="danger"
            icon="alert-octagon-outline"
            text={fill(t.needsDispatch, { n: escalated })}
          />
        </Pressable>
      ) : null}
      {!background ? (
        <Pressable onPress={() => router.push("/disclosure")}>
          <Banner tone="info" icon="map-marker-off-outline" text={t.permissionDenied} />
        </Pressable>
      ) : null}
      {notice === null ? null : <Banner tone="warning" icon="information-outline" text={notice} />}

      <LinearGradient
        colors={[colors.brand, colors.brandDark]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={td.hero}
      >
        <View style={{ flex: 1, gap: space.sm }}>
          <Text style={td.heroLabel}>
            {route === null ? t.tabToday : fill(t.routeLabel, { code: route.code })}
          </Text>
          <Text style={td.heroTitle}>{t.parcelsDone}</Text>
          <View style={td.heroStats}>
            <Stat value={progress.delivered} label={t.delivered} />
            <Stat value={progress.failed} label={t.failed} />
            <Stat value={progress.total - progress.done} label={t.toDo} />
          </View>
          {shift === null ? null : (
            <View style={td.shiftRow}>
              <View style={td.liveDot} />
              <Text style={td.heroSmall}>
                {t.shiftOpen} · {clock(shift.startedAt, locale)}
              </Text>
            </View>
          )}
        </View>
        <ProgressRing done={progress.done} total={progress.total} />
      </LinearGradient>

      {primary}

      <View style={td.quick}>
        <QuickAction
          icon="barcode-scan"
          label={t.scanParcel}
          onPress={() => router.push({ pathname: "/scan", params: { mode: "find" } })}
        />
        <QuickAction
          icon="cash-multiple"
          label={
            toHand.length === 0
              ? t.cashToHand
              : toHand.map((m) => formatMoney(m, locale)).join(" · ")
          }
          tone="cash"
          onPress={() => router.push("/(tabs)/wallet")}
        />
      </View>

      {shift !== null && route !== null ? (
        <Button
          label={t.endShift}
          icon="stop-circle-outline"
          variant="ghost"
          busy={busy}
          onPress={() => void run(() => closeShift(shift.id))}
        />
      ) : null}
    </Screen>
  );
}

function Stat({ value, label }: { readonly value: number; readonly label: string }) {
  return (
    <View style={{ gap: 2 }}>
      <Text style={td.statValue}>{value}</Text>
      <Text style={td.heroSmall}>{label}</Text>
    </View>
  );
}

function QuickAction({
  icon,
  label,
  onPress,
  tone = "brand",
}: {
  readonly icon: IconName;
  readonly label: string;
  readonly onPress: () => void;
  readonly tone?: "brand" | "cash";
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [td.quickItem, pressed && { opacity: 0.85 }]}
    >
      <View
        style={[
          td.quickIcon,
          { backgroundColor: tone === "cash" ? colors.cashSoft : colors.brandSoft },
        ]}
      >
        <Icon name={icon} color={tone === "cash" ? colors.cash : colors.brand} />
      </View>
      <Text style={[type.label, { color: colors.text }]} numberOfLines={2}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Sync state at a glance; a tap sends now. */
function SyncPill() {
  const { t, locale } = useI18n();
  const field = useField();
  const unsent = field.actions.filter((a) => a.state === "PENDING").length;
  const label = field.syncing
    ? t.syncing
    : unsent > 0
      ? fill(t.waitingToSend, { n: unsent })
      : field.lastSyncAt === null
        ? t.notSynced
        : fill(t.syncedAt, { time: clock(field.lastSyncAt, locale) });
  const tone = field.offline || unsent > 0 ? colors.warning : colors.success;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t.syncNow}
      onPress={() => void syncNow().catch(() => undefined)}
      style={[td.pill, { borderColor: tone }]}
    >
      <Icon
        name={field.syncing ? "sync" : unsent > 0 ? "cloud-upload-outline" : "cloud-check-outline"}
        size={16}
        color={tone}
      />
      <Text style={[td.pillText, { color: tone }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const td = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: space.md },
  row: { flexDirection: "row", alignItems: "center", gap: space.md },
  hero: {
    borderRadius: radius.lg,
    padding: space.xl,
    flexDirection: "row",
    alignItems: "center",
    gap: space.lg,
  },
  heroLabel: {
    color: "rgba(255,255,255,0.8)",
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 0.4,
  },
  heroTitle: { color: colors.surface, fontSize: 20, fontWeight: "800" },
  heroStats: { flexDirection: "row", gap: space.xl, marginTop: space.xs },
  statValue: {
    color: colors.surface,
    fontSize: 24,
    fontWeight: "800",
    fontVariant: ["tabular-nums"],
  },
  heroSmall: { color: "rgba(255,255,255,0.85)", fontSize: 12, fontWeight: "600" },
  shiftRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: space.xs },
  liveDot: { width: 8, height: 8, borderRadius: radius.pill, backgroundColor: "#6EE7B7" },
  seq: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    backgroundColor: colors.brand,
    alignItems: "center",
    justifyContent: "center",
  },
  seqText: { color: colors.surface, fontWeight: "800", fontSize: 18 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  actions: { flexDirection: "row", gap: space.md },
  quick: { flexDirection: "row", gap: space.md },
  quickItem: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  },
  quickIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 6,
    maxWidth: 180,
  },
  pillText: { fontSize: 12, fontWeight: "700" },
});
