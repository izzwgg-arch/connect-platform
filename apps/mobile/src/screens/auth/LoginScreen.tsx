/**
 * LoginScreen — built to the "Login and splash mockups" designs
 * (Icon refinement options.zip, Izzy 2026-08-23: "Make it exactly like it").
 *
 * The mockup, faithfully:
 *  - The real chrome LOOPCOM wordmark leads the screen, breathing gently
 *    (slow rise + glow), with the tagline beneath as real text.
 *  - Fields with small uppercase labels; the focused field gets the
 *    #22a8ff ring. Forgot password sits right-aligned under the fields.
 *  - Gradient Sign in button (#22a8ff → #4f7bff) with a slow repeating
 *    sheen crossing it.
 *  - "or" divider, then the outlined "Scan QR code" row.
 *  - "Loopcom · Secure sign-in" foot.
 *  - A soft aurora drifts behind everything.
 *
 * ⛔ THEME RULE (Izzy 2026-08-22, correcting the first cut): the login screen
 * is LIGHT by default; it is dark ONLY when the user's IN-APP theme is dark.
 * The phone's own dark mode does NOT force it — that shipped as
 * `systemDark || isDark` and Izzy rejected it ("The default login screen
 * should be light mode... unless the user already has his app set to dark
 * mode"). That is `isDark`, nothing else.
 *
 * ⛔ The sign-in LOGIC is untouched from the previous screen: same
 * login()/error/shake contract, same QrProvision navigation. Only the view
 * changed. Do not "simplify" the error handling — the shake + banner is how
 * a failed password reads as a refusal rather than a broken app.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Animated,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  ActivityIndicator,
  useWindowDimensions,
  Easing,
  Linking,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import { LoopcomLogo } from '../../components/LoopcomLogo';

/** Mockup: .loginword is 216/292 of the phone width. */
const WORDMARK_FRACTION = 216 / 292;

export function LoginScreen() {
  const { isDark } = useTheme();
  // ⛔ Light by default; dark ONLY when the in-app theme is dark (see header).
  const dk = isDark;

  const { login } = useAuth();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const nav = useNavigation<NativeStackNavigationProp<any>>();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [focused, setFocused] = useState<'email' | 'password' | null>(null);

  const shakeAnim = useRef(new Animated.Value(0)).current;

  // ── Mockup animations ──────────────────────────────────────────────────────
  // settle: brandblock, then form, then or/qr — 0 / 120 / 240 ms stagger.
  const settle1 = useRef(new Animated.Value(0)).current;
  const settle2 = useRef(new Animated.Value(0)).current;
  const settle3 = useRef(new Animated.Value(0)).current;
  // breathe: wordmark rises 3px and back over 4.5s, forever.
  const breathe = useRef(new Animated.Value(0)).current;
  // sheen: a highlight strip crosses the CTA every 4.2s.
  const sheen = useRef(new Animated.Value(0)).current;
  // aurora drift: two glow blobs wander over 14s, alternating.
  const drift = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const settleOne = (v: Animated.Value, delay: number) =>
      Animated.timing(v, { toValue: 1, duration: 900, delay, easing: Easing.out(Easing.cubic), useNativeDriver: true });
    settleOne(settle1, 0).start();
    settleOne(settle2, 120).start();
    settleOne(settle3, 240).start();

    const loops = [
      Animated.loop(
        Animated.sequence([
          Animated.timing(breathe, { toValue: 1, duration: 2250, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
          Animated.timing(breathe, { toValue: 0, duration: 2250, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        ]),
      ),
      Animated.loop(
        Animated.sequence([
          // Mockup sheen: parked off-screen 55% of the cycle, crosses in the last part.
          Animated.delay(2300),
          Animated.timing(sheen, { toValue: 1, duration: 1900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
          Animated.timing(sheen, { toValue: 0, duration: 0, useNativeDriver: true }),
        ]),
      ),
      Animated.loop(
        Animated.sequence([
          Animated.timing(drift, { toValue: 1, duration: 14000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
          Animated.timing(drift, { toValue: 0, duration: 14000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        ]),
      ),
    ];
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [settle1, settle2, settle3, breathe, sheen, drift]);

  const shake = () => {
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 8, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -8, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 6, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -6, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 60, useNativeDriver: true }),
    ]).start();
  };

  const handleLogin = async () => {
    setError('');
    if (!email.trim() || !password) {
      setError('Please enter your email and password.');
      shake();
      return;
    }
    setLoading(true);
    try {
      await login(email.trim().toLowerCase(), password);
    } catch (e: any) {
      setError(e?.message === 'LOGIN_FAILED' ? 'Invalid credentials. Please try again.' : e?.message || 'Sign in failed.');
      shake();
    } finally {
      setLoading(false);
    }
  };

  // ── Palette straight from the mockup's .dk / .lt blocks ────────────────────
  const pal = dk
    ? {
        bg: ['#10203a', '#0a1322', '#060b14'] as const,
        text: '#eaf2fb',
        tag: '#8fa3b8',
        fieldBg: 'rgba(16,27,41,0.82)',
        fieldBorder: 'rgba(255,255,255,0.10)',
        label: '#7e93a9',
        orText: '#68809a',
        orLine: 'rgba(255,255,255,0.10)',
        qrText: '#cfe4f8',
        qrBorder: 'rgba(255,255,255,0.14)',
        qrBg: 'rgba(255,255,255,0.04)',
        foot: '#5d7288',
        aura1: 'rgba(34,168,255,0.20)',
        aura2: 'rgba(79,123,255,0.17)',
      }
    : {
        bg: ['#ffffff', '#f2f7fd', '#e8f0fa'] as const,
        text: '#0d1b2a',
        tag: '#5c6b7c',
        fieldBg: '#ffffff',
        fieldBorder: '#dfe8f2',
        label: '#728598',
        orText: '#8494a8',
        orLine: '#dfe8f2',
        qrText: '#204361',
        qrBorder: '#d5e2ef',
        qrBg: '#ffffff',
        foot: '#93a2b4',
        aura1: 'rgba(34,168,255,0.12)',
        aura2: 'rgba(79,123,255,0.09)',
      };

  const settleStyle = (v: Animated.Value) => ({
    opacity: v,
    transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }],
  });

  const wordmarkWidth = Math.round(width * WORDMARK_FRACTION);
  const sheenX = sheen.interpolate({ inputRange: [0, 1], outputRange: [-width, width] });
  const driftX = drift.interpolate({ inputRange: [0, 1], outputRange: [-14, 16] });
  const driftY = drift.interpolate({ inputRange: [0, 1], outputRange: [-8, 12] });

  const fieldStyle = (name: 'email' | 'password') => [
    styles.field,
    { backgroundColor: pal.fieldBg, borderColor: focused === name ? '#22a8ff' : pal.fieldBorder },
    focused === name && styles.fieldFocus,
    !dk && styles.fieldLightShadow,
  ];

  return (
    <LinearGradient colors={[...pal.bg]} locations={[0, 0.44, 1]} style={styles.flex}>
      {/* Aurora — two soft glow blobs drifting behind the content. */}
      <Animated.View pointerEvents="none" style={[styles.aura, styles.aura1, { backgroundColor: pal.aura1, transform: [{ translateX: driftX }, { translateY: driftY }] }]} />
      <Animated.View pointerEvents="none" style={[styles.aura, styles.aura2, { backgroundColor: pal.aura2, transform: [{ translateX: Animated.multiply(driftX, -1) }, { translateY: Animated.multiply(driftY, -1) }] }]} />

      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24 }]}
          keyboardShouldPersistTaps="handled"
          bounces={false}
          overScrollMode="never"
        >
          {/* Brand block — wordmark breathing, tagline beneath. */}
          <Animated.View style={[styles.brandblock, settleStyle(settle1)]}>
            <Animated.View
              style={{ transform: [{ translateY: breathe.interpolate({ inputRange: [0, 1], outputRange: [0, -3] }) }] }}
            >
              <LoopcomLogo width={wordmarkWidth} />
            </Animated.View>
            <Text style={[styles.tag, { color: pal.tag }]}>Your office phone, in your pocket</Text>
          </Animated.View>

          {/* Form */}
          <Animated.View style={[styles.form, settleStyle(settle2), { transform: [{ translateX: shakeAnim }] }]}>
            <View style={fieldStyle('email')}>
              <Text style={[styles.fieldLabel, { color: pal.label }]}>EMAIL</Text>
              <TextInput
                style={[styles.fieldInput, { color: pal.text }]}
                value={email}
                onChangeText={setEmail}
                onFocus={() => setFocused('email')}
                onBlur={() => setFocused((f) => (f === 'email' ? null : f))}
                placeholder="you@company.com"
                placeholderTextColor={pal.label}
                autoCapitalize="none"
                keyboardType="email-address"
                autoCorrect={false}
                returnKeyType="next"
              />
            </View>

            <View style={fieldStyle('password')}>
              <Text style={[styles.fieldLabel, { color: pal.label }]}>PASSWORD</Text>
              <View style={styles.pwRow}>
                <TextInput
                  style={[styles.fieldInput, styles.pwInput, { color: pal.text }]}
                  value={password}
                  onChangeText={setPassword}
                  onFocus={() => setFocused('password')}
                  onBlur={() => setFocused((f) => (f === 'password' ? null : f))}
                  placeholder="••••••••"
                  placeholderTextColor={pal.label}
                  secureTextEntry={!showPw}
                  returnKeyType="done"
                  onSubmitEditing={handleLogin}
                />
                <TouchableOpacity onPress={() => setShowPw(!showPw)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Text style={[styles.eye, { color: pal.label }]}>{showPw ? 'Hide' : 'Show'}</Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Mockup: right-aligned "Forgot password?" under the fields. The
                only reset path today is the portal's sign-in page, so it opens
                there in the browser. */}
            <TouchableOpacity
              onPress={() => Linking.openURL('https://app.loopcom.net/login').catch(() => undefined)}
              style={styles.forgotTouch}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <Text style={styles.forgot}>Forgot password?</Text>
            </TouchableOpacity>

            {!!error && (
              <View style={styles.errorBanner}>
                <Ionicons name="alert-circle-outline" size={14} color="#ff6b6b" style={{ marginRight: 6 }} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}
          </Animated.View>

          {/* Izzy 2026-08-22: "Move the Sign In and Scan QR button a little bit
              lower on the screen... spread it out and fill them up." The two
              flexible spacers split the leftover height, so the action group
              sits lower and the bottom no longer collects one blank block.
              On short screens they collapse to their minimums and the page
              scrolls as before. */}
          <View style={styles.spacerA} />

          {/* Sign in + or + QR — the action group. */}
          <Animated.View style={settleStyle(settle3)}>
            <TouchableOpacity onPress={handleLogin} disabled={loading} activeOpacity={0.85} style={styles.ctaTouch}>
              <LinearGradient
                colors={['#22a8ff', '#4f7bff']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0.35 }}
                style={styles.cta}
              >
                {loading ? (
                  <ActivityIndicator size="small" color="#f4faff" />
                ) : (
                  <Text style={styles.ctaText}>Sign in</Text>
                )}
                <Animated.View pointerEvents="none" style={[styles.sheen, { transform: [{ translateX: sheenX }, { skewX: '-18deg' }] }]} />
              </LinearGradient>
            </TouchableOpacity>
            <View style={styles.or}>
              <View style={[styles.orLine, { backgroundColor: pal.orLine }]} />
              <Text style={[styles.orText, { color: pal.orText }]}>or</Text>
              <View style={[styles.orLine, { backgroundColor: pal.orLine }]} />
            </View>
            <TouchableOpacity
              style={[styles.qr, { borderColor: pal.qrBorder, backgroundColor: pal.qrBg }]}
              onPress={() => nav.navigate('QrProvision')}
              activeOpacity={0.85}
            >
              <Ionicons name="qr-code-outline" size={18} color={dk ? '#7cc3f7' : '#2f7cc4'} style={{ marginRight: 9 }} />
              <Text style={[styles.qrText, { color: pal.qrText }]}>Scan QR code</Text>
            </TouchableOpacity>
          </Animated.View>

          <View style={styles.spacerB} />
          <Text style={[styles.foot, { color: pal.foot }]}>Loopcom · Secure sign-in</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: { flexGrow: 1, paddingHorizontal: 24 },
  // The vertical-spread spacers: A (fields → Sign in) takes the bigger share,
  // B (QR → foot) the smaller, so the actions land lower without hugging the
  // very bottom. minHeights keep the layout sane on short/keyboard screens.
  spacerA: { flexGrow: 1.3, minHeight: 26 },
  spacerB: { flexGrow: 1, minHeight: 18 },
  aura: { position: 'absolute', borderRadius: 999 },
  aura1: { width: 340, height: 280, top: '6%', left: '-22%' },
  aura2: { width: 300, height: 260, top: '46%', right: '-24%' },
  brandblock: { alignItems: 'center', marginTop: 44 },
  tag: { fontSize: 14, marginTop: 14 },
  form: { marginTop: 34, gap: 12 },
  // Mockup: iPhone fields 14, Android 12; Android CTA + QR are pills.
  field: { borderRadius: Platform.OS === 'android' ? 12 : 14, borderWidth: 1, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 8 },
  fieldFocus: {
    shadowColor: '#22a8ff',
    shadowOpacity: 0.35,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
    elevation: 3,
  },
  fieldLightShadow: {
    shadowColor: '#0d1b2a',
    shadowOpacity: 0.05,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  fieldLabel: { fontSize: 11, fontWeight: '600', letterSpacing: 0.8 },
  fieldInput: { fontSize: 16, paddingVertical: 4, marginTop: 1 },
  pwRow: { flexDirection: 'row', alignItems: 'center' },
  pwInput: { flex: 1 },
  eye: { fontSize: 13, opacity: 0.8 },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,107,107,0.10)',
    borderColor: 'rgba(255,107,107,0.35)',
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
  },
  errorText: { color: '#ff6b6b', fontSize: 13, flex: 1 },
  ctaTouch: { marginTop: 10 },
  cta: {
    borderRadius: Platform.OS === 'android' ? 999 : 14,
    paddingVertical: 15,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    shadowColor: '#2f7cff',
    shadowOpacity: 0.5,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  ctaText: { color: '#f4faff', fontSize: 16, fontWeight: '600' },
  sheen: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 90,
    backgroundColor: 'rgba(255,255,255,0.30)',
  },
  forgotTouch: { alignSelf: 'flex-end', marginTop: -2 },
  forgot: { fontSize: 13, fontWeight: '500', color: '#22a8ff' },
  or: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 18, marginBottom: 4 },
  orLine: { flex: 1, height: 1 },
  orText: { fontSize: 12 },
  qr: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Platform.OS === 'android' ? 999 : 14,
    borderWidth: 1,
    paddingVertical: 13,
    marginTop: 12,
  },
  qrText: { fontSize: 15, fontWeight: '600' },
  foot: { textAlign: 'center', fontSize: 11.5 },
});
