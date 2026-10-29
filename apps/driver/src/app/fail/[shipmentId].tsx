import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { findShipment } from "../../core/manifest";
import { storeVoice } from "../../platform/media";
import type { NewMedia } from "../../platform/outbox-store";
import { record, useField } from "../../services/field";
import { newId } from "../../services/runtime";
import { BackHeader } from "../../ui/back-header";
import { useI18n } from "../../ui/i18n-context";
import { Banner, Button, Chip, EmptyState, Field, Icon, Screen } from "../../ui/kit";
import { Success } from "../../ui/success";
import { VoiceRecorder } from "../../ui/voice-recorder";
import { locationFields, useFixAtTap } from "../../ui/use-fix";
import { colors, radius, space, type } from "../../ui/theme";

/**
 * A failed attempt: one reason from the courier's own list (configured per
 * tenant, labelled in three languages, cached for offline), an optional note,
 * and the device's time and place. Whether the parcel comes back tomorrow or
 * goes back to the sender is shown with each reason, before the tap.
 */
export default function Fail() {
  const { t, locale } = useI18n();
  const { shipmentId } = useLocalSearchParams<{ shipmentId: string }>();
  const field = useField();
  const parcel = findShipment(field.manifests, shipmentId);
  const reasons = field.config?.failureReasons ?? [];
  const [reason, setReason] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [voiceUri, setVoiceUri] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const positionNow = useFixAtTap();
  const voiceEnabled = field.features["DRIVER_VOICE_NOTES_ENABLED"] === true;

  if (parcel === null) {
    return (
      <Screen>
        <BackHeader title={t.failTitle} />
        <EmptyState icon="package-variant-remove" title={t.notOnRoute} />
      </Screen>
    );
  }

  const submit = async () => {
    const occurredAt = new Date().toISOString();
    if (reason === null) return;
    setBusy(true);
    setError(null);
    try {
      const position = await positionNow();
      const media: NewMedia[] = [];
      if (voiceUri !== null) {
        const id = newId();
        media.push({
          id,
          shipmentId: parcel.shipmentId,
          purpose: "VOICE_NOTE" as const,
          ...storeVoice(voiceUri, id),
        });
      }
      await record(
        {
          id: newId(),
          kind: "FAILED",
          subjectId: parcel.shipmentId,
          payload: {
            reasonCode: reason,
            ...(notes.trim() === "" ? {} : { reasonNotes: notes.trim() }),
            ...(voiceUri !== null ? { hasVoiceNote: true } : {}),
            occurredAt,
            ...locationFields(position),
          },
        },
        media.length > 0 ? media : undefined,
      );
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      setDone(true);
      setTimeout(() => router.back(), 900);
    } catch {
      setError(t.tryAgain);
      setBusy(false);
    }
  };

  if (done) {
    return <Success title={t.stateFAILED} body={field.offline ? t.savedOffline : undefined} />;
  }

  return (
    <Screen
      edges={["top", "bottom"]}
      footer={
        <Button
          label={t.confirmFail}
          icon="content-save-outline"
          variant="danger"
          busy={busy}
          disabled={reason === null}
          onPress={() => void submit()}
        />
      }
    >
      <BackHeader title={t.failTitle} />
      <Text style={type.caption}>
        {parcel.recipientName} · {parcel.trackingNumber}
      </Text>
      <Text style={type.title}>{t.chooseReason}</Text>
      {reasons.length === 0 ? (
        <Banner tone="warning" icon="cloud-off-outline" text={t.noReasons} />
      ) : null}
      <View style={{ gap: space.sm }} accessibilityRole="radiogroup">
        {reasons.map((r) => {
          const selected = reason === r.code;
          return (
            <Pressable
              key={r.code}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              onPress={() => {
                void Haptics.selectionAsync();
                setReason(r.code);
              }}
              style={[fl.option, selected && fl.selected]}
            >
              <Icon
                name={selected ? "radiobox-marked" : "radiobox-blank"}
                color={selected ? colors.danger : colors.muted}
              />
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={type.heading}>{r.labels[locale] ?? r.labels["fr"] ?? r.code}</Text>
                <Chip
                  tone={r.allowsReattempt ? "info" : "warning"}
                  icon={r.allowsReattempt ? "calendar-refresh-outline" : "keyboard-return"}
                  label={r.allowsReattempt ? t.willRetry : t.goesBack}
                />
              </View>
            </Pressable>
          );
        })}
      </View>
      <Field
        label={t.notesOptional}
        value={notes}
        onChangeText={setNotes}
        multiline
        maxLength={500}
      />
      {voiceEnabled ? (
        voiceUri !== null ? (
          <Banner tone="success" icon="microphone-outline" text={t.voiceNoteSaved} />
        ) : (
          <VoiceRecorder onRecorded={setVoiceUri} />
        )
      ) : null}
      {error === null ? null : <Banner tone="danger" icon="alert-circle-outline" text={error} />}
    </Screen>
  );
}

const fl = StyleSheet.create({
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  selected: { borderColor: colors.danger, backgroundColor: colors.dangerSoft },
});
