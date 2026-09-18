import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { colors, radius, spacing, typography } from '../theme/tokens'
import { formatJobStatusLabel, JOB_STATUS_BADGE, normalizeJobStatus } from '../lib/productionLine'

export function StatusBadge({ status }: { status: string }) {
  const key = normalizeJobStatus(status)
  const token = JOB_STATUS_BADGE[key] || { bg: 'rgba(148,163,184,0.14)', fg: colors.textSecondary }
  return (
    <View style={[styles.badge, { backgroundColor: token.bg }]}>
      <Text style={[styles.text, { color: token.fg }]}>{formatJobStatusLabel(status)}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  badge: {
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  text: {
    ...typography.caption,
    fontWeight: '600',
  },
})
