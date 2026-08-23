import React, { useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
  Dimensions,
  useWindowDimensions,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LoopcomLogo } from '../../components/LoopcomLogo';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../../context/ThemeContext';
import { typography } from '../../theme/typography';
import { spacing, radius } from '../../theme/spacing';

const { width, height } = Dimensions.get('window');

export function WelcomeScreen() {
  const { colors, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const nav = useNavigation<NativeStackNavigationProp<any>>();

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(40)).current;
  const logoAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.sequence([
      Animated.timing(logoAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
      Animated.parallel([
        Animated.timing(fadeAnim, { toValue: 1, duration: 500, useNativeDriver: true }),
        Animated.timing(slideAnim, { toValue: 0, duration: 500, useNativeDriver: true }),
      ]),
    ]).start();

    // the avatar breathes for as long as the screen is up
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.08, duration: 1400, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 1400, useNativeDriver: true }),
      ])
    );
    pulse.start();
    return () => pulse.stop();
  }, []);

  return (
    <LinearGradient
      colors={isDark
        ? ['#090e18', '#0d1830', '#111827']
        : ['#FFFFFF', '#F3F7FC', '#E9F0FA']}
      locations={isDark ? undefined : [0, 0.55, 1]}
      style={styles.container}
    >
      {/* Background glow circles */}
      <View style={[styles.glow1, { backgroundColor: isDark ? 'rgba(59,130,246,0.08)' : 'rgba(34,168,255,0.10)' }]} />
      <View style={[styles.glow2, { backgroundColor: isDark ? 'rgba(6,182,212,0.06)' : 'rgba(79,123,255,0.07)' }]} />

      {/* Logo area — ⛔ UNCHANGED FROM THE ORIGINAL. Izzy, 2026-08-21:
          "put that avatar back the way it was". Do not restyle it, do not
          resize it, do not put a Loopcom mark or logo inside it. */}
      <Animated.View
        style={[
          styles.logoArea,
          { opacity: logoAnim, transform: [{ scale: pulseAnim }] },
        ]}
      >
        <View style={[styles.logoRing, { borderColor: 'rgba(59,130,246,0.3)' }]}>
          <View style={[styles.logoInner, { backgroundColor: 'rgba(59,130,246,0.15)' }]}>
            <Ionicons name="call" size={40} color="#3b82f6" />
          </View>
        </View>
      </Animated.View>

      {/* The LOGO itself is static — Izzy, 2026-08-21: "stop the animation of
          the Loopcom logo". The avatar above animates; this must not. */}
      <View style={styles.logoWordmark}>
        <LoopcomLogo width={Math.round(width * 0.72)} />
      </View>

      {/* Main content */}
      <Animated.View
        style={[
          styles.content,
          {
            opacity: fadeAnim,
            transform: [{ translateY: slideAnim }],
            paddingBottom: insets.bottom + spacing['10'],
          },
        ]}
      >

        {/* CTAs */}
        <TouchableOpacity
          style={[styles.primaryBtn, { backgroundColor: '#3b82f6' }]}
          onPress={() => nav.navigate('Login')}
          activeOpacity={0.85}
        >
          <Text style={styles.primaryBtnText}>Sign In</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.secondaryBtn, { borderColor: isDark ? 'rgba(59,130,246,0.4)' : 'rgba(30,107,232,0.45)' }]}
          onPress={() => nav.navigate('QrProvision')}
          activeOpacity={0.85}
        >
          <Ionicons
            name="qr-code-outline"
            size={18}
            color={isDark ? 'rgba(147,197,253,0.9)' : '#1E6BE8'}
            style={{ marginRight: 8 }}
          />
          <Text style={[styles.secondaryBtnText, { color: isDark ? 'rgba(147,197,253,0.9)' : '#1E6BE8' }]}>
            Scan QR to Pair Device
          </Text>
        </TouchableOpacity>
      </Animated.View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glow1: {
    position: 'absolute',
    width: width * 0.8,
    height: width * 0.8,
    borderRadius: width * 0.4,
    top: -width * 0.2,
    left: -width * 0.15,
  },
  glow2: {
    position: 'absolute',
    width: width * 0.6,
    height: width * 0.6,
    borderRadius: width * 0.3,
    bottom: 0,
    right: -width * 0.1,
  },
  logoArea: {
    marginBottom: 40,
    alignItems: 'center',
  },
  logoRing: {
    width: 120,
    height: 120,
    borderRadius: 60,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoInner: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoWordmark: {
    // The block that used to hold the wordmark text, the sub-line and the
    // feature chips. Its height is kept so removing them does not move
    // anything else. Izzy, 2026-08-21: "put it back to the same position on
    // the screen that it was in."
    //
    // Measured from the pre-change screen recording on a Galaxy S24
    // (1080x2340 @ 420dpi = 411x891dp): the avatar's centre sat at 178dp and
    // the Sign In button's top edge at 585dp, which leaves exactly 307dp
    // between the avatar's 40dp bottom margin and the buttons.
    //
    // Measured again after the first build: 307 put the avatar 29dp high and
    // the buttons 29dp low, i.e. this block was 58dp too tall. 249 is the
    // corrected value, verified against the original recording.
    height: 249,
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  content: {
    width: '100%',
    paddingHorizontal: spacing['8'],
    alignItems: 'center',
  },
  primaryBtn: {
    width: '100%',
    height: 52,
    borderRadius: radius['2xl'],
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  primaryBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  secondaryBtn: {
    width: '100%',
    height: 52,
    borderRadius: radius['2xl'],
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
  secondaryBtnText: {
    fontSize: 15,
    fontWeight: '600',
  },
});
