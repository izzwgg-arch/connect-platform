/**
 * SplashScreen — the brand moment, built to the "Login and splash mockups"
 * designs (Icon refinement options.zip, Izzy 2026-08-23: "Make it exactly
 * like it").
 *
 * The sequence, per the mockup:
 *   1. The infinity mark SPRINGS in (overshoot then settle), with a faint
 *      aurora behind.
 *   2. The LOOPCOM wordmark rises beneath it.
 *   3. ~2 seconds, then straight into the app (fade-out).
 *
 * ⛔ NO GLOW PAD / "BALL" (Izzy 2026-08-23: "Take away that circle, the ball
 * that comes on top of the logo"). The mockup's pulsing radial glow relied on
 * CSS blur; React Native has no cheap blur, so it rendered as a hard-edged
 * translucent disc sitting ON the mark. It is deleted — never re-add it
 * without a real blur.
 *
 * ⛔ THEME (Izzy 2026-08-23, superseding "brand navy in both themes"): the
 * splash follows the IN-APP theme just like the launcher icon — light theme
 * gets the light splash, dark theme the navy one. RootNavigator gates the
 * splash on ThemeContext.ready so a dark-theme user never sees a light
 * first frame while the saved theme is still loading.
 *
 * ⛔ THE DOTS RULE (Izzy 2026-08-23): the three loading dots appear ONLY if
 * the app is ACTUALLY still thinking — i.e. auth/session restore has not
 * resolved by the time the wordmark has landed. A fast launch never shows
 * them; they disappear the moment `authReady` flips true. Never render them
 * unconditionally — an always-on "thinking" indicator is a lie.
 *
 * ⛔ SIGNED-IN ONLY: this overlay is mounted by RootNavigator solely when a
 * token exists (`showSplash = … && !!token` — Izzy 2026-08-21 and re-stated
 * 2026-08-23). A signed-out launch goes straight to the sign-in screen.
 *
 * Lifecycle contract (unchanged): shows ≥ MIN_SHOW_MS, calls `onReady` once
 * that has elapsed AND the caller set `authReady`, fading out first.
 */
import React, { useEffect, useRef, useCallback, useState } from 'react';
import {
  View,
  StyleSheet,
  Animated,
  Easing,
  useWindowDimensions,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { LoopcomMark } from '../components/LoopcomMark';
import { LoopcomLogo } from '../components/LoopcomLogo';
import { useTheme } from '../context/ThemeContext';

/** Mockup: "about two seconds, then straight into the app". */
const MIN_SHOW_MS = 2_000;
/** Mockup proportions: mark 198/292, wordmark 210/292 of the screen width. */
const MARK_FRACTION = 198 / 292;
const WORD_FRACTION = 210 / 292;
/** If auth still hasn't resolved this long in, the app is genuinely thinking. */
const THINKING_GRACE_MS = 1_200;

interface Props {
  /** Set to true once auth state is resolved. The splash then finishes on its own schedule. */
  authReady: boolean;
  /** Called when the splash is fully done and the navigator should take over. */
  onReady: () => void;
}

export function SplashScreen({ authReady, onReady }: Props) {
  const { width } = useWindowDimensions();
  const { isDark } = useTheme();

  // ── Animations ─────────────────────────────────────────────────────────────
  const screenFade = useRef(new Animated.Value(1)).current;
  const markOpacity = useRef(new Animated.Value(0)).current;
  const markScale = useRef(new Animated.Value(0.55)).current;
  const wordOpacity = useRef(new Animated.Value(0)).current;
  const wordRise = useRef(new Animated.Value(16)).current;
  const dotAnims = useRef([new Animated.Value(0), new Animated.Value(0), new Animated.Value(0)]).current;

  // ── Lifecycle state (contract unchanged from the previous splash) ──────────
  const minTimeDone = useRef(false);
  const authDone = useRef(authReady);
  const exitStarted = useRef(false);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  // ⛔ Dots only when actually thinking: still unresolved past the grace.
  const [thinking, setThinking] = useState(false);

  const maybeExit = useCallback(() => {
    if (exitStarted.current) return;
    if (!minTimeDone.current || !authDone.current) return;
    exitStarted.current = true;
    Animated.timing(screenFade, {
      toValue: 0,
      duration: 320,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start(() => onReadyRef.current());
  }, [screenFade]);

  useEffect(() => {
    authDone.current = authReady;
    if (authReady) {
      setThinking(false); // the moment it stops thinking, the dots go
      maybeExit();
    }
  }, [authReady, maybeExit]);

  useEffect(() => {
    // 1) Mark springs in — overshoot to ~1.05 then settle (mockup's
    //    cubic-bezier(.34,1.4,.5,1)). Animated.spring gives the same shape.
    Animated.parallel([
      Animated.timing(markOpacity, { toValue: 1, duration: 340, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.spring(markScale, { toValue: 1, stiffness: 160, damping: 12, mass: 1, useNativeDriver: true }),
    ]).start();

    // 2) Wordmark rises beneath, slightly after the mark lands.
    Animated.parallel([
      Animated.timing(wordOpacity, { toValue: 1, duration: 500, delay: 380, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(wordRise, { toValue: 0, duration: 500, delay: 380, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start();

    // Minimum display window.
    const minTimer = setTimeout(() => {
      minTimeDone.current = true;
      maybeExit();
    }, MIN_SHOW_MS);

    // ⛔ Dots gate: only if auth is STILL unresolved once the wordmark has
    // landed does the splash admit to thinking.
    const thinkTimer = setTimeout(() => {
      if (!authDone.current) setThinking(true);
    }, THINKING_GRACE_MS);

    return () => {
      clearTimeout(minTimer);
      clearTimeout(thinkTimer);
    };
  }, [markOpacity, markScale, maybeExit, wordOpacity, wordRise]);

  // Dot bounce, staggered 0 / 180 / 360 ms — started only while thinking.
  useEffect(() => {
    if (!thinking) return;
    const loops = dotAnims.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 180),
          Animated.timing(v, { toValue: 1, duration: 585, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
          Animated.timing(v, { toValue: 0, duration: 715, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [thinking, dotAnims]);

  const markWidth = Math.round(width * MARK_FRACTION);
  const wordWidth = Math.round(width * WORD_FRACTION);

  // Splash follows the in-app theme (light splash on light, navy on dark).
  const bg: readonly [string, string, string] = isDark
    ? ['#10203a', '#0a1322', '#060b14']
    : ['#ffffff', '#f2f7fd', '#e8f0fa'];
  const dotColor = isDark ? '#3f8fd8' : '#2f7cc4';

  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.root, { opacity: screenFade }]}>
      {/* ⛔ Gradient only — no aurora blobs. Same reason the glow pad went: the
          mockup's blurred shapes render in RN as HARD-EDGED discs, and on the
          light splash they read as two pale saucers in the corners. A plain
          brand gradient is the clean answer until there is a real blur. */}
      <LinearGradient colors={bg} locations={[0, 0.44, 1]} style={StyleSheet.absoluteFill} />

      <View style={styles.center}>
        <Animated.View style={{ opacity: markOpacity, transform: [{ scale: markScale }] }}>
          <LoopcomMark width={markWidth} variant={isDark ? 'chrome' : 'light'} />
        </Animated.View>
        <Animated.View style={{ opacity: wordOpacity, transform: [{ translateY: wordRise }], marginTop: 30 }}>
          <LoopcomLogo width={wordWidth} />
        </Animated.View>

        {/* ⛔ Only while genuinely thinking. */}
        {thinking && (
          <View style={styles.dots}>
            {dotAnims.map((v, i) => (
              <Animated.View
                key={i}
                style={[
                  styles.dot,
                  {
                    backgroundColor: dotColor,
                    opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.25, 1] }),
                    transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [0, -4] }) }],
                  },
                ]}
              />
            ))}
          </View>
        )}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { zIndex: 999, elevation: 999 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  dots: { flexDirection: 'row', gap: 7, marginTop: 26 },
  dot: { width: 6, height: 6, borderRadius: 3 },
});
