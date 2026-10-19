import { router } from "expo-router";
import { useState } from "react";
import { Linking, ScrollView, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { requestPermissions } from "../platform/device";
import { Button } from "../ui/button";
import { useI18n } from "../ui/i18n-context";
import { styles } from "../ui/theme";

/**
 * Prominent disclosure before the background-location request (Google Play
 * User Data policy; docs/technology-decisions.md §5.3, mitigation 4). It says,
 * in the driver's language and before any system dialog: what is collected,
 * that it happens with the app closed, why, and when it stops.
 *
 * Declining is a real choice: nothing is requested, and the driver can come
 * back. Granting only foreground location is reported, with the way to fix it.
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
        router.replace("/shift");
      } else {
        setDenied(true);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>{t.disclosureTitle}</Text>
        <Text style={styles.body}>{t.disclosureBody}</Text>
        <Button label={t.disclosureAccept} onPress={() => void accept()} busy={busy} />
        <Button
          label={t.disclosureDecline}
          onPress={() => router.replace("/shift")}
          variant="secondary"
        />
        {denied ? (
          <>
            <Text style={styles.warning}>{t.permissionDenied}</Text>
            <Button
              label={t.openSettings}
              onPress={() => void Linking.openSettings()}
              variant="secondary"
            />
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
