import { useEffect, useRef } from "react";
import { Animated, Modal, Pressable, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";

const MAX_SCALE = 5;
const MIN_SCALE = 1;

/**
 * A full-screen photo viewer with pinch-to-zoom, double-tap-to-zoom and
 * one-finger pan while zoomed in. `react-native-reanimated` isn't installed
 * (checked against the pinned Expo SDK 54 set here — adding it would pull in
 * its own Babel plugin and a native rebuild this pass didn't want to risk
 * for one screen), so this drives plain React Native `Animated` values from
 * `react-native-gesture-handler`'s gesture callbacks instead — same visual
 * result, no extra native dependency. See docs/community/parity.md.
 */
export function Lightbox({ uri, onClose }: { uri: string | null; onClose: () => void }) {
  const { width, height } = useWindowDimensions();
  const scale = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const baseScale = useRef(1);
  const baseX = useRef(0);
  const baseY = useRef(0);

  function reset(toScale = 1) {
    baseScale.current = toScale;
    baseX.current = 0;
    baseY.current = 0;
    Animated.parallel([
      Animated.spring(scale, { toValue: toScale, useNativeDriver: true }),
      Animated.spring(translateX, { toValue: 0, useNativeDriver: true }),
      Animated.spring(translateY, { toValue: 0, useNativeDriver: true }),
    ]).start();
  }

  useEffect(() => {
    reset(1);
  }, [uri]);

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      const next = Math.min(Math.max(baseScale.current * e.scale, MIN_SCALE), MAX_SCALE);
      scale.setValue(next);
    })
    .onEnd((e) => {
      const next = Math.min(Math.max(baseScale.current * e.scale, MIN_SCALE), MAX_SCALE);
      if (next <= MIN_SCALE) reset(1);
      else baseScale.current = next;
    });

  const pan = Gesture.Pan()
    .onUpdate((e) => {
      if (baseScale.current <= MIN_SCALE) return;
      translateX.setValue(baseX.current + e.translationX);
      translateY.setValue(baseY.current + e.translationY);
    })
    .onEnd((e) => {
      if (baseScale.current <= MIN_SCALE) return;
      baseX.current += e.translationX;
      baseY.current += e.translationY;
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      reset(baseScale.current > MIN_SCALE ? 1 : 2.5);
    });

  const singleTap = Gesture.Tap()
    .numberOfTaps(1)
    .onEnd(() => {
      if (baseScale.current <= MIN_SCALE) onClose();
    });

  const zoomAndPan = Gesture.Simultaneous(pinch, pan);
  const composed = Gesture.Exclusive(doubleTap, Gesture.Simultaneous(zoomAndPan, singleTap));

  return (
    <Modal visible={!!uri} transparent animationType="fade" onRequestClose={onClose}>
      <GestureHandlerRootView style={{ flex: 1, backgroundColor: "#000" }}>
        <GestureDetector gesture={composed}>
          <Animated.View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            {uri ? (
              <Animated.Image
                source={{ uri }}
                resizeMode="contain"
                style={{ width, height: height * 0.85, transform: [{ translateX }, { translateY }, { scale }] }}
              />
            ) : null}
          </Animated.View>
        </GestureDetector>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close photo"
          style={{ position: "absolute", top: 48, right: 20, width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.15)", alignItems: "center", justifyContent: "center" }}
        >
          <Animated.Text style={{ color: "#fff", fontSize: 18, fontWeight: "700" }}>✕</Animated.Text>
        </Pressable>
      </GestureHandlerRootView>
    </Modal>
  );
}
