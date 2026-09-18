import React from 'react'
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { NativeStackScreenProps } from '@react-navigation/native-stack'
import { Ionicons } from '@expo/vector-icons'
import { Screen } from '../../components/Screen'
import { apiRequest } from '../../api/client'
import { BRAND } from '../../config/env'
import { openFromNotificationPayload } from '../../notifications/openFromNotification'
import { JobsStackParamList } from '../../types/navigation'

type Props = NativeStackScreenProps<JobsStackParamList, 'NotificationsHome'>

type MobileNotification = {
  id: string
  type: string
  title: string
  message: string | null
  status: 'UNREAD' | 'READ' | 'DISMISSED'
  linkType: string | null
  linkId: string | null
  linkUrl: string | null
  data?: { deepLink?: string; traceId?: string } | null
  createdAt: string
}

export function NotificationsScreen({ navigation }: Props) {
  const queryClient = useQueryClient()

  const notificationsQuery = useQuery({
    queryKey: ['mobile-notifications'],
    queryFn: () =>
      apiRequest<{
        notifications: MobileNotification[]
        unreadCount: number
      }>('/api/mobile/notifications?limit=100'),
    refetchInterval: 15000,
  })

  const notifications = notificationsQuery.data?.notifications || []
  const unreadCount = notificationsQuery.data?.unreadCount || 0

  const markRead = async (id: string) => {
    await apiRequest('/api/mobile/notifications/read', 'POST', { notificationId: id })
    await queryClient.invalidateQueries({ queryKey: ['mobile-notifications'] })
    await queryClient.invalidateQueries({ queryKey: ['mobile-notifications-unread'] })
  }

  const openNotification = async (item: MobileNotification) => {
    await markRead(item.id).catch(() => null)
    await openFromNotificationPayload({
      deepLink: item?.data?.deepLink || undefined,
      url: item.linkUrl || undefined,
      linkType: item.linkType || undefined,
      linkId: item.linkId || undefined,
    }).catch(() => null)
  }

  const markAllRead = async () => {
    await apiRequest('/api/mobile/notifications/read', 'POST', { markAll: true })
    await queryClient.invalidateQueries({ queryKey: ['mobile-notifications'] })
    await queryClient.invalidateQueries({ queryKey: ['mobile-notifications-unread'] })
  }

  return (
    <Screen style={styles.screen}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Notifications</Text>
        <Pressable style={styles.markAllButton} onPress={() => markAllRead().catch(() => Alert.alert('Failed to mark all as read'))}>
          <Text style={styles.markAllText}>Mark all read</Text>
        </Pressable>
      </View>

      <Pressable
        style={styles.settingsButton}
        onPress={() => navigation.navigate('NotificationSettings')}
        accessibilityRole="button"
        accessibilityLabel="Notification settings"
      >
        <Ionicons name="settings-outline" size={18} color="#fff" />
        <Text style={styles.settingsText}>Notification settings</Text>
      </Pressable>

      <Text style={styles.subTitle}>Unread: {unreadCount}</Text>

      <FlatList
        data={notifications}
        keyExtractor={(item) => item.id}
        refreshing={notificationsQuery.isRefetching}
        onRefresh={() => notificationsQuery.refetch()}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => openNotification(item).catch(() => null)}
            style={[styles.row, item.status === 'UNREAD' ? styles.rowUnread : null]}
          >
            <Text style={styles.rowTitle}>{item.title}</Text>
            {item.message ? <Text style={styles.rowBody}>{item.message}</Text> : null}
            <Text style={styles.rowMeta}>
              {new Date(item.createdAt).toLocaleString()}
              {item?.data?.traceId ? ` • ${item.data.traceId}` : ''}
            </Text>
          </Pressable>
        )}
        ListEmptyComponent={<Text style={styles.empty}>No notifications yet.</Text>}
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  screen: { padding: 12, gap: 8 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 24, fontWeight: '800', color: BRAND.text },
  subTitle: { color: BRAND.muted, fontSize: 13 },
  settingsButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: BRAND.primary,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  settingsText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  markAllButton: { borderWidth: 1, borderColor: BRAND.primary, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 },
  markAllText: { color: BRAND.primary, fontWeight: '700' },
  row: { borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 10, backgroundColor: '#fff', padding: 10, marginBottom: 8 },
  rowUnread: { borderColor: BRAND.primary, backgroundColor: '#F0F9FF' },
  rowTitle: { color: BRAND.text, fontSize: 15, fontWeight: '700' },
  rowBody: { marginTop: 4, color: BRAND.text, fontSize: 13 },
  rowMeta: { marginTop: 6, color: BRAND.muted, fontSize: 11 },
  empty: { marginTop: 20, color: BRAND.muted, textAlign: 'center' },
})
