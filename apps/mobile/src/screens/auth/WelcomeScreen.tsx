import React, { useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
  Dimensions,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../../context/ThemeContext';
import { typography } from '../../theme/typography';
import { spacing, radius } from '../../theme/spacing';

const { width, height } = Dimensions.get('window');

export function WelcomeScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
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
      colors={['#090e18', '#0d1830', '#111827']}
      style={styles.container}
    >
      {/* Background glow circles */}
      <View style={[styles.glow1, { backgroundColor: 'rgba(59,130,246,0.08)' }]} />
      <View style={[styles.glow2, { backgroundColor: 'rgba(6,182,212,0.06)' }]} />

      {/* Logo area */}
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
        <Text style={[typography.displayMd, { color: '#f0f4ff', textAlign: 'center' }]}>
          Connect
        </Text>
        <Text style={[typography.displayMd, { color: '#3b82f6', textAlign: 'center', marginTop: -6 }]}>
          Communications
        </Text>
        <Text
          style={[
            typography.bodyLg,
            { color: 'rgba(136,153,187,0.9)', textAlign: 'center', marginTop: 14, lineHeight: 26 },
          ]}
        >
          Your enterprise communications hub.{'\n'}Calls, team, contacts — all in one place.
        </Text>

        {/* Feature chips */}
        <View style={styles.chips}>
          {['SIP Softphone', 'HD Audio', 'Team Chat', 'Voicemail'].map((f) => (
            <View key={f} style={[styles.featureChip, { backgroundColor: 'rgba(59,130,246,0.1)', borderColor: 'rgba(59,130,246,0.2)' }]}>
              <Text style={{ color: 'rgba(147,197,253,0.9)', fontSize: 12, fontWeight: '600' }}>{f}</Text>
            </View>
          ))}
        </View>

        {/* CTAs */}
        <TouchableOpacity
          style={[styles.primaryBtn, { backgroundColor: '#3b82f6' }]}
          onPress={() => nav.navigate('Login')}
          activeOpacity={0.85}
        >
          <Text style={styles.primaryBtnText}>Sign In</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.secondaryBtn, { borderColor: 'rgba(59,130,246,0.4)' }]}
          onPress={() => nav.navigate('QrProvision')}
          activeOpacity={0.85}
        >
          <Ionicons name="qr-code-outline" size={18} color="rgba(147,197,253,0.9)" style={{ marginRight: 8 }} />
          <Text style={[styles.secondaryBtnText, { color: 'rgba(147,197,253,0.9)' }]}>
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
  content: {
    width: '100%',
    paddingHorizontal: spacing['8'],
    alignItems: 'center',
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    marginTop: 20,
    marginBottom: 32,
  },
  featureChip: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 20,
    borderWidth: 1,
    margin: 4,
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
