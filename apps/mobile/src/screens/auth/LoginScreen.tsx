import React, { useRef, useState } from 'react';
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
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import { typography } from '../../theme/typography';
import { spacing, radius } from '../../theme/spacing';

export function LoginScreen() {
  const { colors, isDark } = useTheme();
  const { login } = useAuth();
  const insets = useSafeAreaInsets();
  const nav = useNavigation<NativeStackNavigationProp<any>>();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const shakeAnim = useRef(new Animated.Value(0)).current;

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

  return (
    <LinearGradient
      colors={isDark ? ['#090e18', '#0d1830', '#111827'] : ['#f0f4f9', '#e8eef5', '#f0f4f9']}
      style={styles.gradient}
    >
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={[styles.scroll, { paddingTop: insets.top + spacing['6'], paddingBottom: insets.bottom + spacing['8'] }]}
          keyboardShouldPersistTaps="handled"
        >
          {/* Back */}
          <TouchableOpacity
            onPress={() => nav.goBack()}
            style={styles.backBtn}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons name="arrow-back" size={22} color={colors.text} />
          </TouchableOpacity>

          {/* Header */}
          <View style={styles.header}>
            <View style={[styles.iconWrap, { backgroundColor: colors.primaryMuted, borderColor: colors.primary + '40' }]}>
              <Ionicons name="person-circle-outline" size={32} color={colors.primary} />
            </View>
            <Text style={[typography.displayMd, { color: colors.text, marginTop: 20 }]}>
              Welcome back
            </Text>
            <Text style={[typography.body, { color: colors.textSecondary, marginTop: 6 }]}>
              Sign in to your account
            </Text>
          </View>

          {/* Form card */}
          <Animated.View
            style={[
              styles.card,
              {
                backgroundColor: colors.surface,
                borderColor: colors.border,
                transform: [{ translateX: shakeAnim }],
              },
            ]}
          >
            {/* Email */}
            <View style={[styles.inputGroup, { borderColor: colors.border, backgroundColor: colors.surfaceElevated }]}>
              <Ionicons name="mail-outline" size={18} color={colors.textTertiary} style={styles.inputIcon} />
              <TextInput
                style={[styles.input, { color: colors.text }]}
                value={email}
                onChangeText={setEmail}
                placeholder="Email address"
                placeholderTextColor={colors.textTertiary}
                autoCapitalize="none"
                keyboardType="email-address"
                autoCorrect={false}
                returnKeyType="next"
              />
            </View>

            {/* Password */}
            <View style={[styles.inputGroup, { borderColor: colors.border, backgroundColor: colors.surfaceElevated, marginBottom: 0 }]}>
              <Ionicons name="lock-closed-outline" size={18} color={colors.textTertiary} style={styles.inputIcon} />
              <TextInput
                style={[styles.input, { color: colors.text }]}
                value={password}
                onChangeText={setPassword}
                placeholder="Password"
                placeholderTextColor={colors.textTertiary}
                secureTextEntry={!showPw}
                returnKeyType="done"
                onSubmitEditing={handleLogin}
              />
              <TouchableOpacity onPress={() => setShowPw(!showPw)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name={showPw ? 'eye-off-outline' : 'eye-outline'} size={18} color={colors.textTertiary} />
              </TouchableOpacity>
            </View>

            {/* Error */}
            {!!error && (
              <View style={[styles.errorBanner, { backgroundColor: colors.dangerMuted, borderColor: colors.danger + '50' }]}>
                <Ionicons name="alert-circle-outline" size={14} color={colors.dangerText} style={{ marginRight: 6 }} />
                <Text style={[typography.bodySm, { color: colors.dangerText, flex: 1 }]}>{error}</Text>
              </View>
            )}

            {/* Sign In btn */}
            <TouchableOpacity
              style={[styles.signInBtn, { backgroundColor: colors.primary, opacity: loading ? 0.7 : 1 }]}
              onPress={handleLogin}
              disabled={loading}
              activeOpacity={0.85}
            >
              {loading ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.signInBtnText}>Sign In</Text>
              )}
            </TouchableOpacity>
          </Animated.View>

          {/* QR alternative */}
          <View style={styles.divider}>
            <View style={[styles.dividerLine, { backgroundColor: colors.border }]} />
            <Text style={[typography.caption, { color: colors.textTertiary, marginHorizontal: 12 }]}>OR</Text>
            <View style={[styles.dividerLine, { backgroundColor: colors.border }]} />
          </View>

          <TouchableOpacity
            style={[styles.qrBtn, { borderColor: colors.border, backgroundColor: colors.surfaceElevated }]}
            onPress={() => nav.navigate('QrProvision')}
            activeOpacity={0.85}
          >
            <Ionicons name="qr-code-outline" size={20} color={colors.primary} style={{ marginRight: 10 }} />
            <Text style={[typography.labelLg, { color: colors.primary }]}>Scan QR Code to Link Device</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  gradient: { flex: 1 },
  flex: { flex: 1 },
  scroll: { paddingHorizontal: spacing['5'] },
  backBtn: { marginBottom: spacing['4'], alignSelf: 'flex-start', padding: 4 },
  header: { alignItems: 'center', marginBottom: spacing['8'] },
  iconWrap: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5 },
  card: { borderRadius: radius.xl, borderWidth: 1, padding: spacing['5'], marginBottom: spacing['6'] },
  inputGroup: {
    height: 50,
    borderRadius: radius.lg,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing['4'],
    marginBottom: spacing['3'],
  },
  inputIcon: { marginRight: 10 },
  input: { flex: 1, fontSize: 15, height: '100%' },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing['3'],
    borderRadius: radius.md,
    borderWidth: 1,
    marginTop: spacing['3'],
    marginBottom: spacing['2'],
  },
  signInBtn: {
    height: 52,
    borderRadius: radius['2xl'],
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing['5'],
  },
  signInBtnText: { color: '#fff', fontSize: 16, fontWeight: '700', letterSpacing: 0.3 },
  divider: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing['4'] },
  dividerLine: { flex: 1, height: 1 },
  qrBtn: {
    height: 52,
    borderRadius: radius['2xl'],
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
});
