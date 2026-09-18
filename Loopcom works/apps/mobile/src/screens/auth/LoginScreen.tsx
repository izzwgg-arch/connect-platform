import React, { useState } from 'react'
import { Alert, Image, Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { Screen } from '../../components/Screen'
import { useAuth } from '../../auth/AuthContext'
import { colors, spacing, radius, shadows } from '../../theme/tokens'
import { useBranding } from '../../branding/BrandingContext'

function BrandLogo() {
  const { branding } = useBranding()
  const [imgError, setImgError] = useState(false)
  const logoUrl = (!imgError && branding.loginLogoUrl) ? branding.loginLogoUrl : null
  const bgColor = branding.sidebarColor || colors.brandPrimary
  const textColor = branding.menuColor || '#E6C98B'
  const displayName = branding.appDisplayName || 'TrimPro'

  return (
    <View style={[styles.logoContainer]}>
      <View style={[styles.logoBox, { backgroundColor: bgColor }]}>
        {logoUrl ? (
          <Image
            source={{ uri: `${logoUrl}?v=${branding.brandingVersion}` }}
            style={{ height: 36, width: 140, resizeMode: 'contain' }}
            onError={() => setImgError(true)}
          />
        ) : (
          <Text style={[styles.logoText, { color: textColor }]}>{displayName}</Text>
        )}
      </View>
    </View>
  )
}

export function LoginScreen() {
  const { signIn } = useAuth()
  const { branding } = useBranding()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  const onSubmit = async () => {
    if (!email || !password) {
      Alert.alert('Missing fields', 'Enter your email and password.')
      return
    }
    setLoading(true)
    try {
      await signIn(email.trim(), password)
    } catch (error: any) {
      Alert.alert('Login failed', error?.message || 'Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Screen style={styles.root} padded={false}>
      <View style={styles.container}>
        <View style={styles.card}>
          <View style={styles.header}>
            <BrandLogo />
            <Text style={styles.subtitle}>Sign in to your account</Text>
          </View>

          <View style={styles.form}>
            <View style={styles.inputGroup}>
              <Text style={styles.label}>Email</Text>
              <TextInput
                autoCapitalize="none"
                keyboardType="email-address"
                placeholder="Email"
                placeholderTextColor={colors.textPrimary}
                style={styles.input}
                value={email}
                onChangeText={setEmail}
              />
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.label}>Password</Text>
              <TextInput
                secureTextEntry
                placeholder="Password"
                placeholderTextColor={colors.textPrimary}
                style={styles.input}
                value={password}
                onChangeText={setPassword}
              />
            </View>

            <Pressable
              style={[styles.button, { backgroundColor: branding.buttonColor || '#2E4A59' }, loading && styles.buttonDisabled]}
              onPress={onSubmit}
              disabled={loading}
            >
              <Text style={[styles.buttonText, { color: branding.buttonTextColor || '#E6C98B' }]}>{loading ? 'Signing in...' : 'Sign in'}</Text>
            </Pressable>

            <Pressable style={styles.forgotLink}>
              <Text style={[styles.forgotText, { color: branding.primaryColor || '#2E4A59' }]}>Forgot password?</Text>
            </Pressable>
          </View>

          <View style={styles.footer}>
            <Text style={styles.footerText}>
              By signing in, you agree to our{' '}
              <Text style={[styles.footerLink, { color: branding.primaryColor || '#2E4A59' }]} onPress={() => Linking.openURL('https://app.trimprony.com/terms')}>
                Terms
              </Text>{' '}
              and{' '}
              <Text style={[styles.footerLink, { color: branding.primaryColor || '#2E4A59' }]} onPress={() => Linking.openURL('https://app.trimprony.com/privacy')}>
                Privacy Policy
              </Text>
              .
            </Text>
          </View>
        </View>
      </View>
    </Screen>
  )
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: '#F9FAFB',
  },
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.xxl,
    ...shadows.card,
  },
  header: {
    alignItems: 'center',
    marginBottom: spacing.xl,
    paddingTop: spacing.xl,
    paddingBottom: spacing.md,
  },
  logoContainer: {
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  logoBox: {
    borderRadius: radius.md,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  logoText: {
    fontFamily: 'System',
    fontWeight: '700',
    fontSize: 30,
    letterSpacing: -0.02,
  },
  subtitle: {
    fontSize: 14,
    color: colors.textSecondary,
    marginTop: spacing.md,
    textAlign: 'center',
  },
  form: {
    gap: spacing.lg,
  },
  inputGroup: {
    gap: spacing.sm,
  },
  label: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.textPrimary,
  },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: '#D0D5DD',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    fontSize: 16,
    color: colors.textPrimary,
  },
  button: {
    marginTop: spacing.sm,
    borderRadius: radius.sm,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    fontWeight: '700',
    fontSize: 16,
  },
  forgotLink: {
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  forgotText: {
    fontSize: 14,
    textDecorationLine: 'underline',
  },
  footer: {
    marginTop: spacing.xl,
    paddingTop: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
    alignItems: 'center',
  },
  footerText: {
    fontSize: 12,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 18,
  },
  footerLink: {
    textDecorationLine: 'underline',
  },
})

