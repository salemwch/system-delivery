// The background location task is defined before anything else, at module
// scope: a headless launch by Android must find it registered even though no
// screen will mount (src/background/location-task.ts).
import "./src/background/location-task";
import "expo-router/entry";
