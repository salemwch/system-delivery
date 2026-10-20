import { CameraView } from "expo-camera";
import type { BarcodeScanningResult } from "expo-camera";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { pickupParcels } from "../core/field-endpoints";
import { fill } from "../core/i18n";
import { findParcel } from "../core/manifest";
import { localScans } from "../platform/outbox-store";
import { record, useField } from "../services/field";
import { api, newId } from "../services/runtime";
import { CameraGate } from "../ui/camera";
import { useI18n } from "../ui/i18n-context";
import { Icon } from "../ui/kit";
import type { IconName } from "../ui/kit";
import { colors, radius, space } from "../ui/theme";

/** The same label held in view fires many reads; one per this window counts. */
const REPEAT_MS = 2_500;

type Flash = { readonly tone: "ok" | "warn"; readonly text: string } | null;

/**
 * The scanner, in two modes:
 * - `find`: which stop is this parcel? Scan, and the stop opens.
 * - `pickup`: collecting at a merchant. Every scan is queued at once
 *   (offline-safe, replayed in a batch), with a haptic tick and a running
 *   count against the parcels expected.
 * A torn label is typed instead; the code is the bare tracking number.
 */
export default function Scan() {
  const { t } = useI18n();
  const params = useLocalSearchParams<{ mode?: string; pickupId?: string }>();
  const pickupId = params.mode === "pickup" ? (params.pickupId ?? null) : null;
  const field = useField();
  const [torch, setTorch] = useState(false);
  const [typed, setTyped] = useState("");
  const [flash, setFlash] = useState<Flash>(null);
  const [scanned, setScanned] = useState<ReadonlySet<string>>(new Set());
  const [expected, setExpected] = useState<number | null>(null);
  const last = useRef<{ code: string; at: number }>({ code: "", at: 0 });

  useEffect(() => {
    if (pickupId === null) return;
    void localScans(pickupId).then((codes) =>
      setScanned(new Set(codes.map((c) => c.toUpperCase()))),
    );
    void (async () => {
      try {
        const manifest = await pickupParcels(await api(), pickupId);
        setExpected(manifest.summary.total);
        setScanned((current) => {
          const next = new Set(current);
          for (const p of manifest.data) {
            if (p.scanStatus === "SCANNED") next.add(p.trackingNumber.toUpperCase());
          }
          return next;
        });
      } catch {
        // Offline: the local scans are the count; the server reconciles later.
      }
    })();
  }, [pickupId]);

  const show = (tone: "ok" | "warn", text: string) => {
    setFlash({ tone, text });
    void (tone === "ok"
      ? Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      : Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning));
  };

  const handle = async (raw: string) => {
    const code = raw.trim().toUpperCase();
    const now = Date.now();
    if (code === "" || (code === last.current.code && now - last.current.at < REPEAT_MS)) return;
    last.current = { code, at: now };

    if (pickupId === null) {
      const hit = findParcel(field.manifests, code);
      if (hit === null) {
        show("warn", t.notOnRoute);
        return;
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace({ pathname: "/stop/[id]", params: { id: hit.stopId } });
      return;
    }
    if (scanned.has(code)) {
      show("warn", `${code} · ${t.alreadyScanned}`);
      return;
    }
    setScanned((current) => new Set(current).add(code));
    show("ok", code);
    await record({
      id: newId(),
      kind: "PICKUP_SCAN",
      subjectId: pickupId,
      payload: { trackingNumber: code, scannedAt: new Date(now).toISOString() },
    });
  };

  const onBarcode = (result: BarcodeScanningResult) => void handle(result.data);

  return (
    <View style={sx.root}>
      <CameraGate>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          enableTorch={torch}
          barcodeScannerSettings={{
            barcodeTypes: ["qr", "code128", "code39", "ean13", "datamatrix"],
          }}
          onBarcodeScanned={onBarcode}
        />
        <SafeAreaView style={sx.overlay} edges={["top", "bottom"]}>
          <View style={sx.top}>
            <RoundButton icon="close" label={t.back} onPress={() => router.back()} />
            {pickupId === null ? (
              <Text style={sx.title}>{t.scanTitle}</Text>
            ) : (
              <View style={sx.counter}>
                <Text style={sx.counterText}>
                  {fill(t.scannedCount, { scanned: scanned.size, total: expected ?? "?" })}
                </Text>
              </View>
            )}
            <RoundButton
              icon={torch ? "flashlight-off" : "flashlight"}
              label={t.torch}
              onPress={() => setTorch((v) => !v)}
            />
          </View>

          <View style={sx.frameWrap} pointerEvents="none">
            <View style={sx.frame} />
            <Text style={sx.hint}>{t.scanHint}</Text>
          </View>

          <KeyboardAvoidingView behavior="padding">
            {flash === null ? null : (
              <View
                style={[
                  sx.flash,
                  { backgroundColor: flash.tone === "ok" ? colors.success : colors.warning },
                ]}
              >
                <Icon
                  name={flash.tone === "ok" ? "check-circle" : "alert"}
                  color={colors.surface}
                />
                <Text style={sx.flashText} numberOfLines={2}>
                  {flash.text}
                </Text>
              </View>
            )}
            <View style={sx.manual}>
              <TextInput
                value={typed}
                onChangeText={setTyped}
                placeholder={t.typeCode}
                placeholderTextColor="rgba(255,255,255,0.6)"
                autoCapitalize="characters"
                autoCorrect={false}
                style={sx.input}
                onSubmitEditing={() => {
                  void handle(typed);
                  setTyped("");
                }}
                returnKeyType="search"
              />
              <RoundButton
                icon="keyboard-return"
                label={t.find}
                onPress={() => {
                  void handle(typed);
                  setTyped("");
                }}
              />
            </View>
            {pickupId === null ? null : (
              <Pressable accessibilityRole="button" onPress={() => router.back()} style={sx.done}>
                <Text style={sx.doneText}>{t.scanDone}</Text>
              </Pressable>
            )}
          </KeyboardAvoidingView>
        </SafeAreaView>
      </CameraGate>
    </View>
  );
}

function RoundButton({
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
      style={sx.round}
    >
      <Icon name={icon} color={colors.surface} />
    </Pressable>
  );
}

const FRAME = 250;

const sx = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  overlay: { flex: 1, justifyContent: "space-between", padding: space.lg },
  top: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
  },
  title: { color: colors.surface, fontSize: 18, fontWeight: "700" },
  counter: {
    backgroundColor: "rgba(0,0,0,0.55)",
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
  },
  counterText: {
    color: colors.surface,
    fontWeight: "800",
    fontSize: 15,
    fontVariant: ["tabular-nums"],
  },
  round: {
    width: 48,
    height: 48,
    borderRadius: radius.pill,
    backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "center",
    justifyContent: "center",
  },
  frameWrap: { alignItems: "center", gap: space.lg },
  frame: {
    width: FRAME,
    height: FRAME,
    borderRadius: radius.lg,
    borderWidth: 3,
    borderColor: colors.surface,
  },
  hint: { color: colors.surface, fontSize: 15, fontWeight: "600", textAlign: "center" },
  flash: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    marginBottom: space.md,
  },
  flashText: { color: colors.surface, fontWeight: "700", fontSize: 15, flex: 1 },
  manual: { flexDirection: "row", alignItems: "center", gap: space.sm },
  input: {
    flex: 1,
    minHeight: 48,
    borderRadius: radius.md,
    backgroundColor: "rgba(0,0,0,0.55)",
    color: colors.surface,
    paddingHorizontal: space.lg,
    fontSize: 16,
    fontWeight: "600",
    letterSpacing: 1,
  },
  done: {
    marginTop: space.md,
    minHeight: 52,
    borderRadius: radius.md,
    backgroundColor: colors.brand,
    alignItems: "center",
    justifyContent: "center",
  },
  doneText: { color: colors.surface, fontSize: 17, fontWeight: "700" },
});
