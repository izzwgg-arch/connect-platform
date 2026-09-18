import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { Screen } from '../../components/Screen'
import { BRAND } from '../../config/env'
import { clearOutbox, flushOutbox, loadOutbox, OutboxAction, removeOutboxAction } from '../../offline/outbox'
import { useAuth } from '../../auth/AuthContext'
import { useOnlineState } from '../../hooks/useOnlineState'

export function OutboxScreen() {
  const { token } = useAuth()
  const isOnline = useOnlineState()
  const [items, setItems] = useState<OutboxAction[]>([])
  const [syncing, setSyncing] = useState(false)

  const refresh = useCallback(async () => {
    const next = await loadOutbox()
    setItems(next)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const onSyncNow = async () => {
    if (!token) return
    if (!isOnline) {
      Alert.alert('Offline', 'Connect to internet to sync queued actions.')
      return
    }
    setSyncing(true)
    try {
      const result = await flushOutbox(token)
      await refresh()
      Alert.alert('Sync complete', `Processed ${result.processed}. Remaining ${result.remaining}.`)
    } catch (error: any) {
      Alert.alert('Sync failed', error?.message || 'Please try again.')
    } finally {
      setSyncing(false)
    }
  }

  const onRemove = async (id: string) => {
    await removeOutboxAction(id)
    await refresh()
  }

  const onClear = async () => {
    Alert.alert('Clear outbox?', 'This will remove all queued actions.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: async () => {
          await clearOutbox()
          await refresh()
        },
      },
    ])
  }

  const summary = useMemo(() => `${items.length} queued`, [items.length])

  return (
    <Screen style={styles.screen}>
      <Text style={styles.title}>Outbox</Text>
      <Text style={styles.meta}>
        {summary} - {isOnline ? 'Online' : 'Offline'}
      </Text>

      <View style={styles.actions}>
        <Pressable style={[styles.primaryButton, syncing && styles.disabled]} onPress={onSyncNow} disabled={syncing}>
          <Text style={styles.primaryText}>{syncing ? 'Syncing...' : 'Sync now'}</Text>
        </Pressable>
        <Pressable style={styles.secondaryButton} onPress={refresh}>
          <Text style={styles.secondaryText}>Refresh</Text>
        </Pressable>
        <Pressable style={styles.dangerButton} onPress={onClear}>
          <Text style={styles.dangerText}>Clear all</Text>
        </Pressable>
      </View>

      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        ListEmptyComponent={<Text style={styles.empty}>Outbox is empty.</Text>}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <Text style={styles.cardType}>{item.type}</Text>
            <Text style={styles.cardPayload} numberOfLines={2}>
              {JSON.stringify(item.payload)}
            </Text>
            <Pressable style={styles.removeButton} onPress={() => onRemove(item.id)}>
              <Text style={styles.removeText}>Remove</Text>
            </Pressable>
          </View>
        )}
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  screen: { padding: 14, gap: 10 },
  title: { fontSize: 24, fontWeight: '800', color: BRAND.text },
  meta: { color: BRAND.muted, fontSize: 13 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  primaryButton: {
    backgroundColor: BRAND.primary,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  primaryText: { color: BRAND.white, fontWeight: '700' },
  disabled: { opacity: 0.7 },
  secondaryButton: {
    borderColor: '#D0D5DD',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  secondaryText: { color: BRAND.text, fontWeight: '600' },
  dangerButton: {
    borderColor: '#FDA29B',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  dangerText: { color: '#B42318', fontWeight: '700' },
  empty: { color: BRAND.muted, textAlign: 'center', marginTop: 40 },
  card: { backgroundColor: BRAND.white, borderRadius: 12, padding: 12, marginBottom: 8, gap: 6 },
  cardType: { color: BRAND.text, fontWeight: '700', textTransform: 'uppercase', fontSize: 12 },
  cardPayload: { color: BRAND.muted, fontSize: 12 },
  removeButton: { alignSelf: 'flex-start' },
  removeText: { color: '#B42318', fontWeight: '700' },
})

