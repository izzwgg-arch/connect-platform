import React from 'react'
import { KeyboardAvoidingView, Platform, SafeAreaView, StyleProp, StyleSheet, ViewStyle } from 'react-native'
import { colors, spacing } from '../theme/tokens'

export function AppScreen({
  children,
  style,
  padded = true,
}: {
  children: React.ReactNode
  style?: StyleProp<ViewStyle>
  padded?: boolean
}) {
  return (
    <KeyboardAvoidingView style={styles.keyboardContainer} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <SafeAreaView style={[styles.container, padded && styles.padded, style]}>{children}</SafeAreaView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  keyboardContainer: {
    flex: 1,
  },
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  padded: {
    paddingHorizontal: spacing.md,
  },
})

