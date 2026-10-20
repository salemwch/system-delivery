import { CameraView, useCameraPermissions } from "expo-camera";
import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { ActivityIndicator, Linking, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useI18n } from "./i18n-context";
import { Button, EmptyState, Icon } from "./kit";
import { colors, radius, space } from "./theme";

/**
 * Asks for the camera the way the location is asked for: our own screen first
 * saying what it is for, then the system dialog (permission priming). After a
 * permanent refusal, the way out is the app's settings, said plainly.
 */
export function CameraGate({ children }: { readonly children: ReactNode }) {
  const { t } = useI18n();
  const [permission, request] = useCameraPermissions();
  if (permission === null) {
    return (
      <View style={{ flex: 1, justifyContent: "center" }}>
        <ActivityIndicator color={colors.brand} />
      </View>
    );
  }
  if (permission.granted) {
    return <>{children}</>;
  }
  return (
    <EmptyState
      icon="camera-outline"
      title={t.cameraTitle}
      body={t.cameraBody}
      action={
        <View style={{ alignSelf: "stretch", marginTop: space.lg }}>
          {permission.canAskAgain ? (
            <Button label={t.cameraAllow} icon="camera" onPress={() => void request()} />
          ) : (
            <Button
              label={t.openSettings}
              icon="cog-outline"
              variant="secondary"
              onPress={() => void Linking.openSettings()}
            />
          )}
        </View>
      }
    />
  );
}

/** A full-screen camera that returns one photo (a temporary file URI). */
export function PhotoCamera({
  visible,
  onShot,
  onClose,
}: {
  readonly visible: boolean;
  readonly onShot: (uri: string) => void;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const camera = useRef<CameraView>(null);
  const [busy, setBusy] = useState(false);

  const shoot = async () => {
    if (camera.current === null || busy) return;
    setBusy(true);
    try {
      // exif: false — and the file is re-encoded before storage anyway (platform/media.ts).
      const photo = await camera.current.takePictureAsync({ quality: 0.8, exif: false });
      onShot(photo.uri);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={cam.root}>
        <CameraGate>
          <CameraView ref={camera} style={StyleSheet.absoluteFill} facing="back" />
          <SafeAreaView style={cam.overlay} edges={["top", "bottom"]}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t.back}
              onPress={onClose}
              style={cam.close}
            >
              <Icon name="close" color={colors.surface} size={26} />
            </Pressable>
            <View style={cam.bottom}>
              <Text style={cam.hint}>{t.takePhoto}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t.takePhoto}
                onPress={() => void shoot()}
                style={({ pressed }) => [cam.shutter, pressed && { transform: [{ scale: 0.94 }] }]}
              >
                {busy ? (
                  <ActivityIndicator color={colors.ink} />
                ) : (
                  <View style={cam.shutterInner} />
                )}
              </Pressable>
            </View>
          </SafeAreaView>
        </CameraGate>
      </View>
    </Modal>
  );
}

const cam = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  overlay: { flex: 1, justifyContent: "space-between" },
  close: {
    margin: space.lg,
    width: 48,
    height: 48,
    borderRadius: radius.pill,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
  },
  bottom: { alignItems: "center", gap: space.md, paddingBottom: space.xxl },
  hint: { color: colors.surface, fontSize: 15, fontWeight: "600" },
  shutter: {
    width: 78,
    height: 78,
    borderRadius: radius.pill,
    borderWidth: 4,
    borderColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  shutterInner: {
    width: 60,
    height: 60,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
  },
});
