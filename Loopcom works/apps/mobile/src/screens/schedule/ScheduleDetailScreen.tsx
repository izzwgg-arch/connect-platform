import React, { useLayoutEffect } from 'react'
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { NativeStackScreenProps } from '@react-navigation/native-stack'
import { Ionicons } from '@expo/vector-icons'
import { AppScreen } from '../../components/AppScreen'
import { apiRequest } from '../../api/client'
import { colors, spacing, typography } from '../../theme/tokens'
import { Card } from '../../components/Card'
import { EmptyState } from '../../components/EmptyState'
import { useAuth } from '../../auth/AuthContext'
import { useMobilePermissions } from '../../hooks/useMobilePermissions'
import { ScheduleStackParamList } from '../../types/navigation'

type Props = NativeStackScreenProps<ScheduleStackParamList, 'ScheduleDetail'>

interface ScheduleDetailResponse {
  schedule: {
    id: string
    title: string
    description: string | null
    type: string
    startTime: string
    endTime: string
    allDay: boolean
    userId: string
    status?: string
    user?: { id: string; firstName: string; lastName: string; email?: string }
    job?: { id: string; jobNumber: string; title: string } | null
  }
}

function formatDuration(startIso: string, endIso: string) {
  const start = new Date(startIso).getTime()
  const end = new Date(endIso).getTime()
  const diffMs = Math.max(0, end - start)
  const totalMinutes = Math.round(diffMs / 60000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (!hours) return `${minutes}m`
  if (!minutes) return `${hours}h`
  return `${hours}h ${minutes}m`
}

function deriveStatusLabel(schedule: ScheduleDetailResponse['schedule']) {
  if (schedule.status) return schedule.status
  const now = Date.now()
  const start = new Date(schedule.startTime).getTime()
  const end = new Date(schedule.endTime).getTime()
  if (now < start) return 'UPCOMING'
  if (now > end) return 'COMPLETED'
  return 'IN_PROGRESS'
}

export function ScheduleDetailScreen({ navigation, route }: Props) {
  const { scheduleId } = route.params
  const { user } = useAuth()
  const { canCreateSchedulesForOthers } = useMobilePermissions()
  const queryClient = useQueryClient()

  const detailQuery = useQuery({
    queryKey: ['mobile-schedule-detail', scheduleId],
    queryFn: () => apiRequest<ScheduleDetailResponse>(`/api/schedules/${scheduleId}`),
  })

  const deleteMutation = useMutation({
    mutationFn: () => apiRequest<{ message: string }>(`/api/schedules/${scheduleId}`, 'DELETE'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mobile-schedule'] })
      Alert.alert('Deleted', 'Schedule deleted successfully.')
      navigation.navigate('ScheduleHome')
    },
    onError: (error: any) => {
      Alert.alert('Delete failed', error?.message || 'Unable to delete this schedule.')
    },
  })

  const schedule = detailQuery.data?.schedule
  const canManage = schedule ? user?.role === 'ADMIN' || canCreateSchedulesForOthers() || schedule.userId === user?.id : false

  const confirmDelete = () => {
    Alert.alert('Delete schedule', 'Are you sure you want to delete this schedule?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteMutation.mutate() },
    ])
  }

  useLayoutEffect(() => {
    if (!canManage || !schedule) {
      navigation.setOptions({ headerRight: undefined })
      return
    }
    navigation.setOptions({
      headerRight: () => (
        <Pressable
          onPress={() =>
            Alert.alert('Schedule actions', undefined, [
              { text: 'Edit', onPress: () => navigation.navigate('ScheduleCreate', { scheduleId }) },
              { text: 'Delete', style: 'destructive', onPress: confirmDelete },
              { text: 'Cancel', style: 'cancel' },
            ])
          }
          style={styles.headerMenuButton}
        >
          <Ionicons name="ellipsis-vertical" size={18} color={colors.textPrimary} />
        </Pressable>
      ),
    })
  }, [canManage, navigation, schedule, scheduleId])

  if (detailQuery.isLoading) {
    return (
      <AppScreen>
        <EmptyState icon="calendar-outline" title="Loading schedule..." description="Please wait." />
      </AppScreen>
    )
  }

  if (detailQuery.isError || !detailQuery.data?.schedule) {
    return (
      <AppScreen>
        <EmptyState icon="alert-circle-outline" title="Schedule unavailable" description="This schedule could not be loaded." />
      </AppScreen>
    )
  }

  const loaded = detailQuery.data.schedule
  const statusLabel = deriveStatusLabel(loaded)
  const startLabel = new Date(loaded.startTime).toLocaleString()
  const endLabel = new Date(loaded.endTime).toLocaleString()
  const durationLabel = formatDuration(loaded.startTime, loaded.endTime)

  return (
    <AppScreen>
      <ScrollView contentContainerStyle={styles.content}>
        <Card>
          <Text style={styles.title}>{loaded.title || 'Untitled schedule'}</Text>
          <View style={styles.chipsRow}>
            <View style={styles.chip}>
              <Text style={styles.chipText}>{loaded.type.replace('_', ' ')}</Text>
            </View>
            <View style={[styles.chip, styles.statusChip]}>
              <Text style={[styles.chipText, styles.statusText]}>{statusLabel.replace('_', ' ')}</Text>
            </View>
          </View>

          <View style={styles.row}>
            <Text style={styles.rowLabel}>Assigned user</Text>
            <Text style={styles.rowValue}>
              {loaded.user ? `${loaded.user.firstName} ${loaded.user.lastName}` : 'Unassigned'}
            </Text>
          </View>

          <View style={styles.row}>
            <Text style={styles.rowLabel}>Start</Text>
            <Text style={styles.rowValue}>{startLabel}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>End</Text>
            <Text style={styles.rowValue}>{endLabel}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Duration</Text>
            <Text style={styles.rowValue}>{durationLabel}</Text>
          </View>

          {loaded.job ? (
            <Pressable
              style={[styles.row, styles.rowLink]}
              onPress={() => {
                const parentNav = navigation.getParent() as any
                parentNav?.navigate('MainTabs', {
                  screen: 'JobsTab',
                  params: { screen: 'JobDetail', params: { jobId: loaded.job?.id } },
                })
              }}
            >
              <Text style={styles.rowLabel}>Linked job</Text>
              <View style={styles.linkedJobRight}>
                <Text style={[styles.rowValue, styles.rowValueLink]}>
                  {loaded.job.jobNumber} - {loaded.job.title}
                </Text>
                <Ionicons name="chevron-forward" size={16} color={colors.brandPrimary} />
              </View>
            </Pressable>
          ) : null}

          <View style={[styles.notesBlock, loaded.description ? null : styles.notesEmpty]}>
            <Text style={styles.notesLabel}>Notes</Text>
            <Text style={styles.notesText}>{loaded.description?.trim() || 'No notes added.'}</Text>
          </View>
        </Card>
      </ScrollView>
    </AppScreen>
  )
}

const styles = StyleSheet.create({
  content: { gap: spacing.sm, paddingTop: spacing.sm, paddingBottom: spacing.lg },
  headerMenuButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { ...typography.h3, color: colors.textPrimary, marginBottom: spacing.xs },
  chipsRow: { flexDirection: 'row', gap: spacing.xs, marginBottom: spacing.sm },
  chip: {
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: 999,
    minHeight: 30,
    paddingHorizontal: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  chipText: { ...typography.caption, color: colors.textSecondary, fontWeight: '700' },
  statusChip: { borderColor: colors.brandPrimary, backgroundColor: 'rgba(15,76,92,0.08)' },
  statusText: { color: colors.brandPrimary },
  row: {
    minHeight: 44,
    paddingVertical: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  rowLabel: { ...typography.caption, color: colors.textSecondary, fontWeight: '600' },
  rowValue: { ...typography.sub, color: colors.textPrimary, flexShrink: 1, textAlign: 'right' },
  rowLink: { paddingVertical: spacing.sm },
  linkedJobRight: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, justifyContent: 'flex-end' },
  rowValueLink: { color: colors.brandPrimary },
  notesBlock: { marginTop: spacing.md },
  notesEmpty: { opacity: 0.8 },
  notesLabel: { ...typography.caption, color: colors.textSecondary, fontWeight: '700', marginBottom: 6 },
  notesText: { ...typography.body, color: colors.textPrimary, lineHeight: 22 },
})

