import { Tabs } from "expo-router";
import { useEffect } from "react";
import { AppState } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { reload, syncNow, useField } from "../../services/field";
import { useI18n } from "../../ui/i18n-context";
import { Icon } from "../../ui/kit";
import type { IconName } from "../../ui/kit";
import { colors } from "../../ui/theme";

/** While the app is open, the outbox is tried this often; every action also tries at once. */
const SYNC_EVERY_MS = 30_000;

/**
 * The driver's five places, at the bottom where the thumb is: the day, the
 * stops, pickups, the cash and the profile. Sync runs here, so every tab sees
 * the same fresh state: on open, on return to the foreground, and on a timer.
 */
export default function TabsLayout() {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const field = useField();
  const unsent = field.actions.filter((a) => a.state === "PENDING").length;
  const attention = field.actions.filter(
    (a) => a.state === "ESCALATED" || a.state === "REFUSED",
  ).length;

  useEffect(() => {
    const tick = () => void syncNow().catch(() => undefined);
    void reload().then(tick);
    const timer = setInterval(tick, SYNC_EVERY_MS);
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") tick();
    });
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, []);

  const icon =
    (name: IconName, active: IconName) =>
    ({ focused }: { focused: boolean }) => (
      <Icon
        name={focused ? active : name}
        color={focused ? colors.brand : colors.muted}
        size={26}
      />
    );

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.brand,
        tabBarInactiveTintColor: colors.muted,
        tabBarLabelStyle: { fontSize: 12, fontWeight: "600" },
        tabBarStyle: {
          height: 62 + insets.bottom,
          paddingTop: 6,
          paddingBottom: Math.max(insets.bottom, 8),
          borderTopColor: colors.line,
          backgroundColor: colors.surface,
        },
        sceneStyle: { backgroundColor: colors.canvas },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: t.tabToday, tabBarIcon: icon("home-outline", "home") }}
      />
      <Tabs.Screen
        name="stops"
        options={{ title: t.tabStops, tabBarIcon: icon("map-marker-outline", "map-marker") }}
      />
      <Tabs.Screen
        name="pickups"
        options={{
          title: t.tabPickups,
          tabBarIcon: icon("package-variant", "package-variant-closed"),
        }}
      />
      <Tabs.Screen
        name="wallet"
        options={{ title: t.tabWallet, tabBarIcon: icon("wallet-outline", "wallet") }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: t.tabProfile,
          tabBarIcon: icon("account-circle-outline", "account-circle"),
          ...(attention + unsent > 0
            ? {
                tabBarBadge: attention > 0 ? attention : unsent,
                tabBarBadgeStyle: {
                  backgroundColor: attention > 0 ? colors.danger : colors.warning,
                  fontSize: 11,
                },
              }
            : {}),
        }}
      />
    </Tabs>
  );
}
