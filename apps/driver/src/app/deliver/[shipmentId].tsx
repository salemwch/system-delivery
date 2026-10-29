import * as Haptics from "expo-haptics";
import * as ScreenCapture from "expo-screen-capture";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";

import { fill } from "../../core/i18n";
import { formatMoney, isZero } from "../../core/money";
import { findShipment } from "../../core/manifest";
import { discardLocal, storePhoto, storeSignature } from "../../platform/media";
import type { NewMedia } from "../../platform/outbox-store";
import { record, useField } from "../../services/field";
import { newId } from "../../services/runtime";
import { BackHeader } from "../../ui/back-header";
import { PhotoCamera } from "../../ui/camera";
import { useI18n } from "../../ui/i18n-context";
import { Banner, Button, Card, EmptyState, Field, Icon, Screen } from "../../ui/kit";
import { SignaturePad } from "../../ui/signature-pad";
import type { SignatureHandle } from "../../ui/signature-pad";
import { Success } from "../../ui/success";
import { locationFields, useFixAtTap } from "../../ui/use-fix";
import { colors, radius, space, type } from "../../ui/theme";

type Step = "cash" | "proof";

/**
 * Proof of delivery in as few taps as the rules allow (docs/01: at most six):
 * confirm the cash when there is some, then sign or photograph, then confirm.
 *
 * The delivery is written to the outbox before anything is sent; the photo
 * and signature travel separately and never hold the delivery back
 * (core/outbox.ts). The device time and position are taken at the tap.
 */
export default function Deliver() {
  const { t, locale } = useI18n();
  const { shipmentId } = useLocalSearchParams<{ shipmentId: string }>();
  const field = useField();
  const parcel = findShipment(field.manifests, shipmentId);
  const cod = parcel !== null && !isZero(parcel.cod);
  const [step, setStep] = useState<Step>(cod ? "cash" : "proof");
  const [photo, setPhoto] = useState<string | null>(null);
  const [camera, setCamera] = useState(false);
  const [signed, setSigned] = useState(false);
  const [name, setName] = useState(parcel?.recipientName ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [signing, setSigning] = useState(false);
  const signature = useRef<SignatureHandle>(null);
  const positionNow = useFixAtTap();

  const screenshotPrevention =
    field.features["DRIVER_SCREENSHOT_PREVENTION_ENABLED"] === true && cod;
  useEffect(() => {
    if (!screenshotPrevention) return;
    void ScreenCapture.preventScreenCaptureAsync("deliver");
    return () => {
      void ScreenCapture.allowScreenCaptureAsync("deliver");
    };
  }, [screenshotPrevention]);

  if (parcel === null) {
    return (
      <Screen>
        <BackHeader title={t.deliverTitle} />
        <EmptyState icon="package-variant-remove" title={t.notOnRoute} />
      </Screen>
    );
  }

  const photoRequired = field.features["POD_PHOTO_REQUIRED"] === true;
  const signatureRequired = field.features["POD_SIGNATURE_REQUIRED"] === true;

  const submit = async () => {
    const occurredAt = new Date().toISOString();
    if (name.trim() === "") return setError(t.nameRequired);
    if (photoRequired && photo === null) return setError(t.photoRequired);
    if (signatureRequired && !signed) return setError(t.signatureRequired);
    // Cash changed hands: "contactless" is not proof of that (COD_REQUIRES_STRONG_POD).
    if (cod && photo === null && !signed) return setError(t.proofRequired);
    setBusy(true);
    setError(null);
    try {
      const media: NewMedia[] = [];
      const signatureUri = signed ? await signature.current?.capture() : null;
      if (signatureUri !== null && signatureUri !== undefined) {
        const id = newId();
        media.push({
          id,
          shipmentId: parcel.shipmentId,
          purpose: "POD_SIGNATURE",
          ...storeSignature(signatureUri, id),
        });
      }
      if (photo !== null) {
        const id = newId();
        media.push({
          id,
          shipmentId: parcel.shipmentId,
          purpose: "POD_PHOTO",
          ...(await storePhoto(photo, id)),
        });
      }
      const position = await positionNow();
      const podType = media.some((m) => m.purpose === "POD_SIGNATURE")
        ? "signature"
        : media.length > 0
          ? "photo"
          : "contactless";
      await record(
        {
          id: newId(),
          kind: "DELIVERED",
          subjectId: parcel.shipmentId,
          payload: {
            pod: { podType, recipientName: name.trim() },
            ...(cod ? { codCollected: true } : {}),
            occurredAt,
            ...locationFields(position),
          },
        },
        media,
      );
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setDone(true);
      setTimeout(() => router.back(), 1_100);
    } catch {
      setError(t.tryAgain);
      setBusy(false);
    }
  };

  if (done) {
    return <Success title={t.stateDELIVERED} body={field.offline ? t.savedOffline : undefined} />;
  }

  return (
    <Screen
      edges={["top", "bottom"]}
      scrollEnabled={!signing}
      footer={
        step === "cash" ? (
          <Button
            label={fill(t.cashConfirm, { amount: formatMoney(parcel.cod, locale) })}
            icon="cash-check"
            variant="cash"
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              setStep("proof");
            }}
          />
        ) : (
          <Button
            label={t.confirmDelivery}
            icon="check-bold"
            busy={busy}
            onPress={() => void submit()}
          />
        )
      }
    >
      <BackHeader title={t.deliverTitle} />
      <Steps cod={cod} step={step} />

      {step === "cash" ? (
        <Card tone="cash" style={{ alignItems: "center", paddingVertical: space.xxl }}>
          <Icon name="cash-multiple" size={44} color={colors.cash} />
          <Text style={[type.label, { color: colors.cash }]}>{t.collect.toUpperCase()}</Text>
          <Text style={dl.amount}>{formatMoney(parcel.cod, locale)}</Text>
          <Text style={type.caption}>{parcel.recipientName}</Text>
        </Card>
      ) : (
        <>
          <Card>
            <View style={dl.summary}>
              <Icon name="account-check-outline" color={colors.brand} />
              <Text style={[type.heading, { flex: 1 }]}>{parcel.recipientName}</Text>
              {cod ? (
                <Text style={[type.label, { color: colors.success }]}>
                  {formatMoney(parcel.cod, locale)} ✓
                </Text>
              ) : null}
            </View>
          </Card>

          <Text style={type.label}>{t.proofSignature.toUpperCase()}</Text>
          <SignaturePad
            ref={signature}
            label={t.signHere}
            clearLabel={t.clear}
            onInk={setSigned}
            onActive={setSigning}
          />

          <Text style={type.label}>{t.proofPhoto.toUpperCase()}</Text>
          {photo === null ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setCamera(true)}
              style={dl.photoSlot}
            >
              <Icon name="camera-plus-outline" size={30} color={colors.brand} />
              <Text style={[type.label, { color: colors.brand }]}>{t.takePhoto}</Text>
            </Pressable>
          ) : (
            <View style={dl.photoRow}>
              <Image source={{ uri: photo }} style={dl.photo} />
              <Button
                label={t.retake}
                icon="camera-retake-outline"
                variant="secondary"
                compact
                onPress={() => {
                  discardLocal(photo);
                  setPhoto(null);
                  setCamera(true);
                }}
              />
            </View>
          )}

          <Field
            label={t.recipientName}
            value={name}
            onChangeText={setName}
            autoCapitalize="words"
          />
          {error === null ? null : (
            <Banner tone="danger" icon="alert-circle-outline" text={error} />
          )}
        </>
      )}

      <PhotoCamera
        visible={camera}
        onClose={() => setCamera(false)}
        onShot={(uri) => {
          setCamera(false);
          setPhoto(uri);
        }}
      />
    </Screen>
  );
}

function Steps({ cod, step }: { readonly cod: boolean; readonly step: Step }) {
  const { t } = useI18n();
  const steps: readonly { key: Step; label: string }[] = cod
    ? [
        { key: "cash", label: t.stepCash },
        { key: "proof", label: t.stepProof },
      ]
    : [{ key: "proof", label: t.stepProof }];
  if (steps.length === 1) return null;
  const current = steps.findIndex((s) => s.key === step);
  return (
    <View style={dl.steps}>
      {steps.map((s, i) => (
        <View key={s.key} style={dl.step}>
          <View style={[dl.bar, i <= current && { backgroundColor: colors.brand }]} />
          <Text style={[type.caption, i === current && { color: colors.brand, fontWeight: "700" }]}>
            {s.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

const dl = StyleSheet.create({
  amount: { fontSize: 40, fontWeight: "800", color: colors.ink, fontVariant: ["tabular-nums"] },
  summary: { flexDirection: "row", alignItems: "center", gap: space.md },
  photoSlot: {
    height: 120,
    borderRadius: radius.lg,
    borderWidth: 2,
    borderStyle: "dashed",
    borderColor: colors.brand,
    backgroundColor: colors.brandSoft,
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
  },
  photoRow: { flexDirection: "row", alignItems: "center", gap: space.lg },
  photo: { width: 120, height: 120, borderRadius: radius.md, backgroundColor: colors.line },
  steps: { flexDirection: "row", gap: space.md },
  step: { flex: 1, gap: 6 },
  bar: { height: 4, borderRadius: radius.pill, backgroundColor: colors.line },
});
