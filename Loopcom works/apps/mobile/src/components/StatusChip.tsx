import React from 'react'
import { StyleSheet, Text, View } from 'react-native'

function normalizeStatus(status: unknown) {
  return typeof status === 'string' ? status : ''
}

function colorForStatus(status: unknown) {
  const s = normalizeStatus(status).toUpperCase()
  if (s.includes('COMPLETE') || s === 'DONE' || s === 'RESOLVED') return { bg: '#D1FADF', text: '#027A48' }
  if (s.includes('PROGRESS') || s.includes('SITE') || s.includes('ROUTE')) return { bg: '#D1E9FF', text: '#175CD3' }
  if (s.includes('OPEN') || s.includes('ASSIGNED') || s.includes('NEW') || s.includes('TODO')) {
    return { bg: '#FEF0C7', text: '#B54708' }
  }
  return { bg: '#EAECF0', text: '#344054' }
}

export function StatusChip({ status }: { status: string | null | undefined }) {
  const colors = colorForStatus(status)
  const label = normalizeStatus(status).replaceAll('_', ' ') || 'UNKNOWN'
  return (
    <View style={[styles.chip, { backgroundColor: colors.bg }]}>
      <Text style={[styles.text, { color: colors.text }]}>{label}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  chip: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  text: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
})

