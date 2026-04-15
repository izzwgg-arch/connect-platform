/**
 * SplashScreen — branded launch / identity screen.
 *
 * Design system: option #7
 * - Dark premium navy-black gradient background
 * - Centered ConnectIcon with radial glow
 * - Three concentric orbit rings (slow animated rotation)
 * - "Connect" wordmark + elegant subtitle
 * - NO buttons · NO "Get Started" · NO CTAs
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
  Dimensions,
  Platform,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { ConnectIcon } from '../components/ConnectIcon';

const { width } = Dimensions.get('window');

/** Minimum time the splash is visible regardless of how fast auth resolves. */
const MIN_SHOW_MS = 2_400;

/** Orbit ring config: size, border opacity, rotation direction, full-cycle ms. */
const RINGS = [
  { diameter: 176, opacity: 0.45, color: '#38bdf8', dir: 1,  cycleDuration: 9_000 },
  { diameter: 240, opacity: 0.28, color: '#818cf8', dir: -1, cycleDuration: 14_000 },
  { diameter: 308, opacity: 0.15, color: '#38bdf8', dir: 1,  cycleDuration: 20_000 },
] as const;

interface Props {
  /** Set to true once auth state is resolved. The splash will then finish on its own schedule. */
  authReady: boolean;
  /** Called when the splash is fully done and the navigator should take over. */
  onReady: () => void;
}

export function SplashScreen({ authReady, onReady }: Props) {
  // ── Entrance animations ────────────────────────────────────────────────────
  const screenFade  = useRef(new Animated.Value(1)).current;
  const iconFade    = useRef(new Animated.Value(0)).current;
  const iconScale   = useRef(new Animated.Value(0.78)).current;
  const textFade    = useRef(new Animated.Value(0)).current;
  const textSlide   = useRef(new Animated.Value(14)).current;
  const glowPulse   = useRef(new Animated.Value(0.55)).current;

  // ── Orbit ring rotations (one Animated.Value per ring, 0→1) ───────────────
  const ringAnims = useRef(RINGS.map(() => new Animated.Value(0))).current;

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

    // 3. Glow breathing loop
    const glowLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(glowPulse, { toValue: 1,    duration: 1_800, useNativeDriver: true }),
        Animated.timing(glowPulse, { toValue: 0.55, duration: 1_800, useNativeDriver: true }),
      ]),
    );
    glowLoop.start();

    // 4. Orbit rings — slow continuous rotation
    const ringLoops = RINGS.map(({ cycleDuration, dir }, i) =>
      Animated.loop(
        Animated.timing(ringAnims[i], {
          toValue: dir === 1 ? 1 : -1,
          duration: cycleDuration,
          useNativeDriver: true,
        }),
      ),
    );
    ringLoops.forEach((l) => l.start());

    // 5. Min-display timer
    const minTimer = setTimeout(() => {
      minTimeDone.current = true;
      maybeExit();
    }, MIN_SHOW_MS);

    return () => {
      clearTimeout(textTimer);
      clearTimeout(minTimer);
      glowLoop.stop();
      ringLoops.forEach((l) => l.stop());
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

      {/* Ambient background glow — large soft radial bloom */}
      <View pointerEvents="none" style={styles.ambientGlow} />

      {/* ── Orbit rings ── */}
      {RINGS.map(({ diameter, opacity, color, dir }, i) => {
        const spin = ringAnims[i].interpolate({
          inputRange: [dir === 1 ? 0 : -1, dir === 1 ? 1 : 0],
          outputRange: ['0deg', `${dir === 1 ? 360 : -360}deg`],
        });
        return (
          <Animated.View
            key={i}
            pointerEvents="none"
            style={[
              styles.ring,
              {
                width: diameter,
                height: diameter,
                borderRadius: diameter / 2,
                borderColor: `${color}${opacityToHex(opacity)}`,
                transform: [{ rotate: spin }],
              },
            ]}
          />
        );
      })}

      {/* ── Icon glow halo ── */}
      <Animated.View
        pointerEvents="none"
        style={[styles.glowHalo, { opacity: glowPulse }]}
      />

      {/* ── App icon ── */}
      <Animated.View
        style={{
          opacity: iconFade,
          transform: [{ scale: iconScale }],
          ...styles.iconShadow,
        }}
      >
        <ConnectIcon size={100} />
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
        <Text style={styles.appName}>Connect</Text>
        <Text style={styles.tagline}>Business communication, redefined</Text>
      </Animated.View>
    </Animated.View>
  );
}

/** Convert 0–1 float opacity to a 2-char hex string for CSS color notation. */
function opacityToHex(opacity: number): string {
  return Math.round(opacity * 255).toString(16).padStart(2, '0').toUpperCase();
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#040810',
  },

  // Large soft ambient glow behind icon
  ambientGlow: {
    position: 'absolute',
    width: width * 0.75,
    height: width * 0.75,
    borderRadius: (width * 0.75) / 2,
    backgroundColor: 'transparent',
    // Glow via shadow (iOS)
    ...Platform.select({
      ios: {
        shadowColor: '#1d4ed8',
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.55,
        shadowRadius: 80,
      },
    }),
  },

  // Orbit ring base style (size/color overridden per ring)
  ring: {
    position: 'absolute',
    borderWidth: 1,
    borderStyle: 'solid',
  },

  // Tight blue glow halo directly behind icon
  glowHalo: {
    position: 'absolute',
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: 'transparent',
    ...Platform.select({
      ios: {
        shadowColor: '#38bdf8',
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 1,
        shadowRadius: 48,
      },
      android: {
        // Android elevation gives a coloured halo when elevation + bg applied
        elevation: 24,
        backgroundColor: 'rgba(56,189,248,0.05)',
      },
    }),
  },

  iconShadow: {
    ...Platform.select({
      ios: {
        shadowColor: '#2563eb',
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.7,
        shadowRadius: 28,
      },
      android: { elevation: 18 },
    }),
  },

  textBlock: {
    marginTop: 40,
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
    color: '#93c5fd',
    letterSpacing: 0.4,
    opacity: 0.82,
  },
});
