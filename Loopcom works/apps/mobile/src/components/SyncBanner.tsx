import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { BRAND } from '../config/env'

interface SyncBannerProps {
  isOnline: boolean
  isSyncing: boolean
  lastSyncAt?: Date | null
  outboxCount?: number
}

export function SyncBanner({ isOnline, isSyncing, lastSyncAt, outboxCount = 0 }: SyncBannerProps) {
  const label = isOnline ? (isSyncing ? 'Syncing...' : 'Online') : 'Offline'
  const color = isOnline ? BRAND.primary : '#B42318'
  return (
    <View style={styles.row}>
      <Text style={[styles.label, { color }]}>{label}</Text>
      {outboxCount > 0 && <Text style={styles.meta}>Queued: {outboxCount}</Text>}
      {lastSyncAt && <Text style={styles.meta}>Last sync: {lastSyncAt.toLocaleTimeString()}</Text>}
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
    marginBottom: 12,
  },
  label: {
    fontSize: 12,
    fontWeight: '700',
  },
  meta: {
    fontSize: 12,
    color: '#667085',
  },
})

