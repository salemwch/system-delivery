import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { fill } from "../core/i18n";
import { currentFix } from "../platform/device";
import type { Fix } from "../platform/device";
import { record, useField } from "../services/field";
import { newId } from "../services/runtime";
import { BackHeader } from "../ui/back-header";
import { useI18n } from "../ui/i18n-context";
import { Banner, Button, Card, Field, Icon, Screen } from "../ui/kit";
import { Success } from "../ui/success";
import { colors, radius, space, type } from "../ui/theme";

/** Worse than this, the pin would be a guess; the driver is told to step outside. */
const WEAK_FIX_M = 50;

/**
 * The driver, standing at the door, moves the address pin to where they are
 * (docs/01 2.10). The server applies small moves at once and sends large ones
 * (> 2 km) to a dispatcher; either way the next driver finds the door. Works
 * offline: the correction carries the time it was observed.
 */
export default function CorrectLocation() {
  const { t } = useI18n();
  const { addressId } = useLocalSearchParams<{ addressId: string }>();
  const field = useField();
  const [fix, setFix] = useState<Fix | null>(null);
  const [locating, setLocating] = useState(true);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const locate = useCallback(async () => {
    setLocating(true);
    setFix(await currentFix().catch(() => null));
    setLocating(false);
  }, []);

  useEffect(() => {
    void locate();
  }, [locate]);

  const submit = async () => {
    if (fix === null || addressId === undefined || addressId === "") return;
    setBusy(true);
    setError(null);
    try {
      await record({
        id: newId(),
        kind: "ADDRESS_CORRECTED",
        subjectId: addressId,
        payload: {
          coordinates: { lat: fix.lat, lng: fix.lng },
          ...(fix.accuracyM === null ? {} : { accuracyM: fix.accuracyM }),
          ...(notes.trim() === "" ? {} : { accessNotes: notes.trim() }),
          occurredAt: new Date(fix.at).toISOString(),
        },
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setDone(true);
      setTimeout(() => router.back(), 900);
    } catch {
      setError(t.tryAgain);
      setBusy(false);
    }
  };

  if (done) {
    return <Success title={t.correctionSaved} body={field.offline ? t.savedOffline : undefined} />;
  }

  const weak = fix !== null && fix.accuracyM !== null && fix.accuracyM > WEAK_FIX_M;

  return (
    <Screen
      edges={["top", "bottom"]}
      footer={
        <Button
          label={t.saveLocation}
          icon="map-marker-check-outline"
          busy={busy}
          disabled={fix === null || locating}
          onPress={() => void submit()}
        />
      }
    >
      <BackHeader title={t.correctTitle} />
      <Text style={type.body}>{t.correctBody}</Text>
      <Card style={{ alignItems: "center", paddingVertical: space.xxl }}>
        <View style={cl.target}>
          <Icon
            name={locating ? "crosshairs" : fix === null ? "crosshairs-off" : "crosshairs-gps"}
            size={44}
            color={fix === null ? colors.muted : colors.brand}
          />
        </View>
        <Text style={type.heading}>
          {locating
            ? t.locating
            : fix === null
              ? t.noFix
              : fix.accuracyM === null
                ? `${fix.lat.toFixed(5)}, ${fix.lng.toFixed(5)}`
                : fill(t.accuracy, { m: fix.accuracyM })}
        </Text>
        {fix === null || locating ? null : (
          <Text style={[type.caption, { fontVariant: ["tabular-nums"] }]}>
            {fix.lat.toFixed(5)}, {fix.lng.toFixed(5)}
          </Text>
        )}
        <Button
          label={t.tryAgain}
          icon="refresh"
          variant="ghost"
          compact
          disabled={locating}
          onPress={() => void locate()}
        />
      </Card>
      {weak ? <Banner tone="warning" icon="signal-cellular-1" text={t.weakFix} /> : null}
      <Field
        label={t.accessNotes}
        value={notes}
        onChangeText={setNotes}
        multiline
        maxLength={1000}
      />
      {error === null ? null : <Banner tone="danger" icon="alert-circle-outline" text={error} />}
    </Screen>
  );
}

const cl = StyleSheet.create({
  target: {
    width: 96,
    height: 96,
    borderRadius: radius.pill,
    backgroundColor: colors.brandSoft,
    alignItems: "center",
    justifyContent: "center",
  },
});
