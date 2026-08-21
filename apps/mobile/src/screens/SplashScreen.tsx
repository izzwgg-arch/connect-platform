/**
 * SplashScreen — branded launch / identity screen.
 *
 * - Dark premium navy-black gradient background
 * - Centered Loopcom mark
 * - "Loopcom" wordmark + the brand's own tagline
 * - NO buttons · NO "Get Started" · NO CTAs
 *
 * ⛔ Keep this in step with assets/splash.png, which is the same composition
 * rendered as a static image. Both are produced from one set of numbers —
 * SPLASH_* in scripts/mobile-loopcom-android-assets.py — so a change to the
 * mark size, the gaps or the wording belongs in BOTH places or the launch
 * image and the screen that replaces it will not line up.
 *
 * Lifecycle:
 *   Shows for a minimum of MIN_SHOW_MS (2 400 ms).
 *   Calls `onReady` once that time has elapsed AND the caller sets `authReady`.
 *   Fades out gracefully before handing off to the navigator.
 */
import React, { useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Animated,
  Platform,
  useWindowDimensions,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { LoopcomMark } from '../components/LoopcomMark';

/** Minimum time the splash is visible regardless of how fast auth resolves. */
const MIN_SHOW_MS = 2_400;

/** Mark width as a fraction of screen width — mirrors SPLASH_MARK_INK_W. */
const MARK_WIDTH_FRACTION = 0.27;

interface Props {
  /** Set to true once auth state is resolved. The splash will then finish on its own schedule. */
  authReady: boolean;
  /** Called when the splash is fully done and the navigator should take over. */
  onReady: () => void;
}

export function SplashScreen({ authReady, onReady }: Props) {
  const { width } = useWindowDimensions();

  // ── Entrance animations ────────────────────────────────────────────────────
  const screenFade  = useRef(new Animated.Value(1)).current;
  const iconFade    = useRef(new Animated.Value(0)).current;
  const iconScale   = useRef(new Animated.Value(0.78)).current;
  const textFade    = useRef(new Animated.Value(0)).current;
  const textSlide   = useRef(new Animated.Value(14)).current;

  // ── Internal state ─────────────────────────────────────────────────────────
  const minTimeDone  = useRef(false);
  const authDone     = useRef(authReady);
  const exitStarted  = useRef(false);
  const onReadyRef   = useRef(onReady);
  onReadyRef.current = onReady;

  // ── Exit sequence ──────────────────────────────────────────────────────────
  const maybeExit = useCallback(() => {
    if (!minTimeDone.current || !authDone.current || exitStarted.current) return;
    exitStarted.current = true;

    Animated.timing(screenFade, {
      toValue: 0,
      duration: 320,
      useNativeDriver: true,
    }).start(() => onReadyRef.current());
  }, [screenFade]);

  // ── Mount: entrance + continuous animations ────────────────────────────────
  useEffect(() => {
    // 1. Icon fade + spring in
    Animated.parallel([
      Animated.timing(iconFade, {
        toValue: 1,
        duration: 700,
        useNativeDriver: true,
      }),
      Animated.spring(iconScale, {
        toValue: 1,
        damping: 11,
        stiffness: 70,
        useNativeDriver: true,
      }),
    ]).start();

    // 2. Text slides up after icon settles (700 ms delay)
    const textTimer = setTimeout(() => {
      Animated.parallel([
        Animated.timing(textFade, {
          toValue: 1,
          duration: 550,
          useNativeDriver: true,
        }),
        Animated.timing(textSlide, {
          toValue: 0,
          duration: 550,
          useNativeDriver: true,
        }),
      ]).start();
    }, 700);

    // 3. Min-display timer
    const minTimer = setTimeout(() => {
      minTimeDone.current = true;
      maybeExit();
    }, MIN_SHOW_MS);

    return () => {
      clearTimeout(textTimer);
      clearTimeout(minTimer);
    };
  }, []);

  // ── React when authReady flips to true ─────────────────────────────────────
  useEffect(() => {
    authDone.current = authReady;
    if (authReady) maybeExit();
  }, [authReady, maybeExit]);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <Animated.View style={[styles.root, { opacity: screenFade }]}>
      <LinearGradient
        colors={['#040810', '#060c18', '#0a1020', '#08111e', '#040810']}
        locations={[0, 0.2, 0.5, 0.8, 1]}
        style={StyleSheet.absoluteFill}
      />

      {/* ── App icon ── */}
      <Animated.View
        style={{
          opacity: iconFade,
          transform: [{ scale: iconScale }],
          ...styles.iconShadow,
        }}
      >
        <LoopcomMark width={Math.round(width * MARK_WIDTH_FRACTION)} />
      </Animated.View>

      {/* ── Wordmark + tagline ── */}
      <Animated.View
        style={[
          styles.textBlock,
          {
            opacity: textFade,
            transform: [{ translateY: textSlide }],
          },
        ]}
      >
        <Text style={styles.appName}>Loopcom</Text>
        <Text style={styles.tagline}>The AI communications platform</Text>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#040810',
  },
  iconShadow: {
    ...Platform.select({
      ios: {
        shadowColor: '#22A8FF',
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.7,
        shadowRadius: 28,
      },
      // No Android elevation: the artwork carries its own glow, and an
      // elevation on a transparent view draws a rectangular shadow on some OEMs.
      android: {},
    }),
  },

  textBlock: {
    // == SPLASH_GAP_DP in scripts/mobile-loopcom-android-assets.py
    marginTop: 34,
    alignItems: 'center',
  },

  appName: {
    fontSize: 34,
    fontWeight: '700',
    color: '#f0f6ff',
    letterSpacing: 2.5,
    marginBottom: 8,
  },

  tagline: {
    fontSize: 13,
    fontWeight: '400',
    color: '#8FC0F5',
    letterSpacing: 0.4,
    opacity: 0.82,
  },
});
