import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Text } from "react-native";

import { findShipment } from "../../core/manifest";
import { record, useField } from "../../services/field";
import { newId } from "../../services/runtime";
import { BackHeader } from "../../ui/back-header";
import { useI18n } from "../../ui/i18n-context";
import { Banner, Button, Card, EmptyState, Field, Icon, Screen } from "../../ui/kit";
import { Success } from "../../ui/success";
import { colors, type } from "../../ui/theme";

/**
 * Closing a return: the parcel is back with its sender. Who signed for it is
 * optional (a hub counter often has nobody), but recorded when it exists:
 * a sender disputing that a parcel came back is when this record is read.
 */
export default function ReturnHandover() {
  const { t } = useI18n();
  const { shipmentId } = useLocalSearchParams<{ shipmentId: string }>();
  const field = useField();
  const parcel = findShipment(field.todayManifests, shipmentId);
  const [receivedBy, setReceivedBy] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (parcel === null) {
    return (
      <Screen>
        <BackHeader title={t.returnTitle} />
        <EmptyState icon="package-variant-remove" title={t.notOnRoute} />
      </Screen>
    );
  }

  const submit = async () => {
    const occurredAt = new Date().toISOString();
    setBusy(true);
    setError(null);
    try {
      await record({
        id: newId(),
        kind: "RETURN_COMPLETED",
        subjectId: parcel.shipmentId,
        payload: {
          occurredAt,
          ...(receivedBy.trim() === "" ? {} : { receivedByName: receivedBy.trim() }),
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
    return <Success title={t.stateRETURNED} body={field.offline ? t.savedOffline : undefined} />;
  }

  return (
    <Screen
      edges={["top", "bottom"]}
      footer={
        <Button
          label={t.confirmReturn}
          icon="keyboard-return"
          busy={busy}
          onPress={() => void submit()}
        />
      }
    >
      <BackHeader title={t.returnTitle} />
      <Card>
        <Icon name="keyboard-return" size={32} color={colors.info} />
        <Text style={type.heading}>{parcel.trackingNumber}</Text>
        <Text style={type.body}>{t.returnBody}</Text>
      </Card>
      <Field
        label={t.receivedBy}
        value={receivedBy}
        onChangeText={setReceivedBy}
        autoCapitalize="words"
        maxLength={200}
      />
      {error === null ? null : <Banner tone="danger" icon="alert-circle-outline" text={error} />}
    </Screen>
  );
}
