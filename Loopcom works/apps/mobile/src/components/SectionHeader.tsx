import React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, spacing, typography } from '../theme/tokens'

export function SectionHeader({
  title,
  rightActionLabel,
  onRightAction,
}: {
  title: string
  rightActionLabel?: string
  onRightAction?: () => void
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.title}>{title}</Text>
      {rightActionLabel && onRightAction ? (
        <Pressable
          onPress={onRightAction}
          hitSlop={8}
          style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
          android_ripple={{ color: 'rgba(15,76,92,0.12)', borderless: true }}
        >
          <Text style={styles.actionText}>{rightActionLabel}</Text>
        </Pressable>
      ) : (
        <View />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  title: {
    ...typography.h3,
    color: colors.textPrimary,
  },
  action: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
    borderRadius: 8,
  },
  actionPressed: {
    opacity: 0.8,
  },
  actionText: {
    ...typography.sub,
    color: colors.brandPrimary,
  },
})

