/**
 * SplashScreen — the brand moment, built to the "Login and splash mockups"
 * designs (Icon refinement options.zip, Izzy 2026-08-23: "Make it exactly
 * like it").
 *
 * The sequence, per the mockup:
 *   1. The infinity mark SPRINGS in (overshoot then settle) over a softly
 *      pulsing glow pad, with a faint aurora drifting behind.
 *   2. The LOOPCOM wordmark rises beneath it.
 *   3. ~2 seconds, then straight into the app (fade-out).
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
 * ⛔ BRAND NAVY IN BOTH THEMES on purpose (mockup: "it is a brand flash, not
 * a page") — no light variant here, unlike the login screen.
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

  // ── Animations ─────────────────────────────────────────────────────────────
  const screenFade = useRef(new Animated.Value(1)).current;
  const markOpacity = useRef(new Animated.Value(0)).current;
  const markScale = useRef(new Animated.Value(0.55)).current;
  const wordOpacity = useRef(new Animated.Value(0)).current;
  const wordRise = useRef(new Animated.Value(16)).current;
  const glow = useRef(new Animated.Value(0)).current;
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

    // Glow pad pulse, for as long as the splash is up.
    const glowLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(glow, { toValue: 1, duration: 1600, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(glow, { toValue: 0, duration: 1600, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]),
    );
    glowLoop.start();

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
      glowLoop.stop();
      clearTimeout(minTimer);
      clearTimeout(thinkTimer);
    };
  }, [glow, markOpacity, markScale, maybeExit, wordOpacity, wordRise]);

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

  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.root, { opacity: screenFade }]}>
      {/* Brand navy in both themes — the mockup's radial, as a vertical gradient. */}
      <LinearGradient colors={['#10203a', '#0a1322', '#060b14']} locations={[0, 0.44, 1]} style={StyleSheet.absoluteFill} />

      {/* Aurora accents */}
      <View pointerEvents="none" style={[styles.aura, styles.auraA]} />
      <View pointerEvents="none" style={[styles.aura, styles.auraB]} />

      <View style={styles.center}>
        {/* Pulsing glow pad behind the mark */}
        <Animated.View
          pointerEvents="none"
          style={[
            styles.glowpad,
            {
              opacity: glow.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0.9] }),
              transform: [{ scale: glow.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1.08] }) }],
            },
          ]}
        />
        <Animated.View style={{ opacity: markOpacity, transform: [{ scale: markScale }] }}>
          <LoopcomMark width={markWidth} />
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
  glowpad: {
    position: 'absolute',
    width: 300,
    height: 300,
    borderRadius: 150,
    backgroundColor: 'rgba(34,168,255,0.16)',
  },
  aura: { position: 'absolute', borderRadius: 999 },
  auraA: { width: 320, height: 260, top: '10%', left: '-20%', backgroundColor: 'rgba(34,168,255,0.10)' },
  auraB: { width: 300, height: 250, top: '55%', right: '-22%', backgroundColor: 'rgba(79,123,255,0.09)' },
  dots: { flexDirection: 'row', gap: 7, marginTop: 26 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#3f8fd8' },
});
