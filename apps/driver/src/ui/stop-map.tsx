import { StyleSheet, View } from "react-native";
import MapView, { Marker } from "react-native-maps";

import { colors, radius } from "./theme";

const DELTA = 0.005;

export function StopMap({
  latitude,
  longitude,
}: {
  readonly latitude: number;
  readonly longitude: number;
}) {
  return (
    <View style={s.wrapper}>
      <MapView
        style={StyleSheet.absoluteFill}
        initialRegion={{
          latitude,
          longitude,
          latitudeDelta: DELTA,
          longitudeDelta: DELTA,
        }}
        pitchEnabled={false}
        rotateEnabled={false}
        scrollEnabled={false}
        zoomEnabled={false}
        toolbarEnabled={false}
        loadingEnabled
        loadingBackgroundColor={colors.canvas}
        loadingIndicatorColor={colors.brand}
      >
        <Marker coordinate={{ latitude, longitude }} pinColor={colors.brand} />
      </MapView>
    </View>
  );
}

const s = StyleSheet.create({
  wrapper: {
    height: 160,
    borderRadius: radius.md,
    overflow: "hidden",
    backgroundColor: colors.canvas,
  },
});
