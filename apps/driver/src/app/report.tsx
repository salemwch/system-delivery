import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { ApiError } from "../core/api";
import { PROBLEM_TYPES, reportProblem } from "../core/field-endpoints";
import type { ProblemType } from "../core/field-endpoints";
import type { MessageKey } from "../core/i18n";
import { findShipment } from "../core/manifest";
import { useField } from "../services/field";
import { api, newId } from "../services/runtime";
import { BackHeader } from "../ui/back-header";
import { useI18n } from "../ui/i18n-context";
import { Banner, Button, Field, Icon, Screen } from "../ui/kit";
import type { IconName } from "../ui/kit";
import { Success } from "../ui/success";
import { colors, radius, space, type } from "../ui/theme";

const PROBLEM: Readonly<Record<ProblemType, { icon: IconName; label: MessageKey }>> = {
  DAMAGED: { icon: "package-variant-closed-remove", label: "problemDAMAGED" },
  WRONG_ITEM: { icon: "swap-horizontal", label: "problemWRONG_ITEM" },
  LOST: { icon: "help-box-outline", label: "problemLOST" },
  OTHER: { icon: "dots-horizontal-circle-outline", label: "problemOTHER" },
};

/**
 * A problem with a parcel, reported from the street (a réclamation the
 * support team picks up). Online: it is a conversation starter, not an event
 * the day depends on. The idempotency key is minted once per screen, so a
 * retry after a lost answer is the same report, never a second one.
 */
export default function Report() {
  const { t } = useI18n();
  const { shipmentId } = useLocalSearchParams<{ shipmentId: string }>();
  const field = useField();
  const parcel = findShipment(field.todayManifests, shipmentId);
  const [problem, setProblem] = useState<ProblemType | null>(null);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const key = useRef(newId());

  const submit = async () => {
    if (problem === null || shipmentId === undefined || description.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      await reportProblem(await api(), {
        idempotencyKey: key.current,
        type: problem,
        description: description.trim(),
        shipmentId,
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setDone(true);
      setTimeout(() => router.back(), 1_100);
    } catch (failure) {
      setError(failure instanceof ApiError && failure.transient ? t.needsNetwork : t.tryAgain);
    } finally {
      setBusy(false);
    }
  };

  if (done) return <Success title={t.reported} />;

  return (
    <Screen
      edges={["top", "bottom"]}
      footer={
        <Button
          label={t.send}
          icon="send"
          busy={busy}
          disabled={problem === null || description.trim() === ""}
          onPress={() => void submit()}
        />
      }
    >
      <BackHeader title={t.reportTitle} />
      {parcel === null ? null : (
        <Text style={type.caption}>
          {parcel.recipientName} · {parcel.trackingNumber}
        </Text>
      )}
      <View style={rp.grid}>
        {PROBLEM_TYPES.map((kind) => {
          const selected = problem === kind;
          return (
            <Pressable
              key={kind}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              onPress={() => setProblem(kind)}
              style={[rp.tile, selected && rp.selected]}
            >
              <Icon
                name={PROBLEM[kind].icon}
                size={28}
                color={selected ? colors.brand : colors.muted}
              />
              <Text
                style={[
                  type.label,
                  { color: selected ? colors.brandDark : colors.text, textAlign: "center" },
                ]}
              >
                {t[PROBLEM[kind].label]}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Field
        label={t.describe}
        value={description}
        onChangeText={setDescription}
        multiline
        maxLength={4000}
        style={rp.text}
      />
      {error === null ? null : <Banner tone="danger" icon="alert-circle-outline" text={error} />}
    </Screen>
  );
}

const rp = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", gap: space.md },
  tile: {
    width: "47%",
    flexGrow: 1,
    minHeight: 96,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    padding: space.md,
  },
  selected: { borderColor: colors.brand, borderWidth: 2, backgroundColor: colors.brandSoft },
  text: {
    minHeight: 120,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    padding: space.lg,
    fontSize: 16,
    color: colors.ink,
    backgroundColor: colors.surface,
    textAlignVertical: "top",
  },
});
