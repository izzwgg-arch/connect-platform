import React from 'react'
import { ActivityIndicator, Alert, StyleSheet, Switch, Text, View } from 'react-native'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { NativeStackScreenProps } from '@react-navigation/native-stack'
import { Screen } from '../../components/Screen'
import { apiRequest } from '../../api/client'
import { BRAND } from '../../config/env'
import { JobsStackParamList } from '../../types/navigation'

type Props = NativeStackScreenProps<JobsStackParamList, 'NotificationSettings'>

type PrefKey =
  | 'requestStatusChanges'
  | 'jobStatusChanges'
  | 'newMessage'
  | 'newJobAssigned'
  | 'paymentReceived'
  | 'emailNotifications'

type Prefs = Record<PrefKey, boolean>

const ROWS: Array<{ key: PrefKey; title: string; description: string }> = [
  {
    key: 'emailNotifications',
    title: 'Email notifications',
    description: 'Also send alerts to your account email (off by default).',
  },
  {
    key: 'requestStatusChanges',
    title: 'Request status changes',
    description: 'When a request you created or are assigned to changes status.',
  },
  {
    key: 'jobStatusChanges',
    title: 'Job status changes',
    description: 'When a job you created or are assigned to changes status.',
  },
  {
    key: 'newMessage',
    title: 'New message',
    description: 'When you receive a new chat or job message.',
  },
  {
    key: 'newJobAssigned',
    title: 'New job assigned',
    description: 'When a new job is assigned to you.',
  },
  {
    key: 'paymentReceived',
    title: 'Payment received',
    description: 'When a payment is received on a job assigned to you.',
  },
]

const DEFAULTS: Prefs = {
  requestStatusChanges: true,
  jobStatusChanges: true,
  newMessage: true,
  newJobAssigned: true,
  paymentReceived: true,
  emailNotifications: false,
}

export function NotificationSettingsScreen({}: Props) {
  const queryClient = useQueryClient()

  const prefsQuery = useQuery({
    queryKey: ['mobile-notification-preferences'],
    queryFn: () => apiRequest<{ preferences: Prefs }>('/api/mobile/notification-preferences'),
  })

  const prefs = prefsQuery.data?.preferences || DEFAULTS

  const saveMutation = useMutation({
    mutationFn: (next: Prefs) =>
      apiRequest<{ preferences: Prefs }>('/api/mobile/notification-preferences', 'PATCH', {
        preferences: next,
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(['mobile-notification-preferences'], data)
    },
    onError: (error: any) => {
      Alert.alert('Could not save', error?.message || 'Please try again.')
      void prefsQuery.refetch()
    },
  })

  const toggle = (key: PrefKey, value: boolean) => {
    const next = { ...prefs, [key]: value }
    queryClient.setQueryData(['mobile-notification-preferences'], { preferences: next })
    saveMutation.mutate(next)
  }

  return (
    <Screen style={styles.screen}>
      <Text style={styles.title}>Notification settings</Text>
      <Text style={styles.subtitle}>Choose which alerts you want on this account.</Text>

      {prefsQuery.isLoading ? (
        <ActivityIndicator color={BRAND.primary} style={{ marginTop: 24 }} />
      ) : (
        <View style={styles.list}>
          {ROWS.map((row) => (
            <View key={row.key} style={styles.row}>
              <View style={styles.rowText}>
                <Text style={styles.rowTitle}>{row.title}</Text>
                <Text style={styles.rowDesc}>{row.description}</Text>
              </View>
              <Switch
                value={Boolean(prefs[row.key])}
                onValueChange={(value) => toggle(row.key, value)}
                trackColor={{ false: '#CBD5E1', true: BRAND.primary }}
              />
            </View>
          ))}
        </View>
      )}

      {saveMutation.isPending ? <Text style={styles.saving}>Saving…</Text> : null}
    </Screen>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, backgroundColor: BRAND.bg },
  title: { fontSize: 22, fontWeight: '800', color: BRAND.text },
  subtitle: { marginTop: 6, color: BRAND.muted, fontSize: 13, marginBottom: 16 },
  list: { gap: 10 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: BRAND.white,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  rowText: { flex: 1, gap: 4 },
  rowTitle: { fontSize: 15, fontWeight: '700', color: BRAND.text },
  rowDesc: { fontSize: 12, color: BRAND.muted, lineHeight: 16 },
  saving: { marginTop: 12, color: BRAND.muted, fontSize: 12 },
})
