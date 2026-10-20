import { router } from "expo-router";
import { useState } from "react";
import { Linking, StyleSheet, Text, View } from "react-native";

import type { MessageKey } from "../core/i18n";
import { requestPermissions } from "../platform/device";
import { setDisclosureDeclined } from "../services/onboarding";
import { useI18n } from "../ui/i18n-context";
import { Banner, Button, Icon, Screen } from "../ui/kit";
import type { IconName } from "../ui/kit";
import { colors, radius, space, type } from "../ui/theme";

const POINTS: readonly { icon: IconName; text: MessageKey }[] = [
  { icon: "clock-check-outline", text: "discOnlyShift" },
  { icon: "map-marker-radius-outline", text: "discWhy" },
  { icon: "stop-circle-outline", text: "discStops" },
];

/**
 * Prominent disclosure before the background-location request (Google Play
 * User Data policy; docs/technology-decisions.md §5.3, mitigation 4). It says,
 * in the driver's language and before any system dialog: what is collected,
 * that it happens with the app closed, why, and when it stops.
 *
 * Declining is a real choice: nothing is requested, the launch stops asking,
 * and the Today screen offers it again. Granting only foreground location is
 * reported, with the way to fix it.
 */
export default function Disclosure() {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);

  const accept = async () => {
    setBusy(true);
    try {
      const granted = await requestPermissions();
      if (granted.background) {
        await setDisclosureDeclined(false);
        router.replace("/(tabs)");
      } else {
        setDenied(true);
      }
    } finally {
      setBusy(false);
    }
  };

  const decline = async () => {
    await setDisclosureDeclined(true);
    router.replace("/(tabs)");
  };

  return (
    <Screen
      edges={["top", "bottom"]}
      footer={
        <>
          <Button
            label={t.disclosureAccept}
            icon="check"
            onPress={() => void accept()}
            busy={busy}
          />
          <Button label={t.disclosureDecline} variant="ghost" onPress={() => void decline()} />
        </>
      }
    >
      <View style={ds.icon}>
        <Icon name="map-marker-account-outline" size={44} color={colors.brand} />
      </View>
      <Text style={type.title}>{t.disclosureTitle}</Text>
      <Text style={type.body}>{t.disclosureBody}</Text>
      <View style={ds.points}>
        {POINTS.map((point) => (
          <View key={point.text} style={ds.point}>
            <Icon name={point.icon} color={colors.brand} />
            <Text style={[type.body, { flex: 1 }]}>{t[point.text]}</Text>
          </View>
        ))}
      </View>
      {denied ? (
        <>
          <Banner tone="warning" icon="alert-outline" text={t.permissionDenied} />
          <Button
            label={t.openSettings}
            icon="cog-outline"
            onPress={() => void Linking.openSettings()}
            variant="secondary"
          />
        </>
      ) : null}
    </Screen>
  );
}

const ds = StyleSheet.create({
  icon: {
    width: 84,
    height: 84,
    borderRadius: radius.pill,
    backgroundColor: colors.brandSoft,
    alignItems: "center",
    justifyContent: "center",
    marginTop: space.xl,
  },
  points: {
    gap: space.md,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: space.lg,
  },
  point: { flexDirection: "row", alignItems: "center", gap: space.md },
});
