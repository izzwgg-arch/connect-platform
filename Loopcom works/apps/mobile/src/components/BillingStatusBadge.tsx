import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { colors, radius, spacing, typography } from '../theme/tokens'
import { formatBillingStatus } from '../utils/format'

function parsePercent(status?: string | null) {
  if (!status || /^unbilled$/i.test(String(status).trim())) return 0
  const match = String(status).match(/(\d+)\s*%/)
  return match ? Math.max(0, Math.min(100, parseInt(match[1], 10))) : 0
}

function mapBillingStatus(status?: string | null) {
  const percent = parsePercent(status)
  if (percent >= 100) return { bg: 'rgba(22,163,74,0.14)', fg: '#15803D' }
  if (percent >= 85) return { bg: 'rgba(16,185,129,0.14)', fg: '#047857' }
  if (percent >= 65) return { bg: 'rgba(217,119,6,0.14)', fg: '#B45309' }
  if (percent >= 50) return { bg: 'rgba(37,99,235,0.12)', fg: colors.info }
  if (percent > 0) return { bg: 'rgba(100,116,139,0.14)', fg: '#475569' }
  return { bg: 'rgba(148,163,184,0.14)', fg: colors.textSecondary }
}

export function BillingStatusBadge({ status }: { status?: string | null }) {
  const token = mapBillingStatus(status)
  return (
    <View style={[styles.badge, { backgroundColor: token.bg }]}>
      <Text style={[styles.text, { color: token.fg }]}>{formatBillingStatus(status)}</Text>
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
