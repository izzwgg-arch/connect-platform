import React, { useState } from 'react'
import {
  Alert,
  Linking,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Ionicons } from '@expo/vector-icons'
import { AppScreen } from '../../components/AppScreen'
import { DetailSection } from '../../components/DetailSection'
import { apiRequest } from '../../api/client'
import { colors, radius, spacing, typography } from '../../theme/tokens'
import { StatusBadge } from '../../components/StatusBadge'
import { BillingStatusBadge } from '../../components/BillingStatusBadge'
import { JobsStackParamList } from '../../types/navigation'
import { useMobilePermissions } from '../../hooks/useMobilePermissions'
import { Job, TimeEntry } from '../../types/models'
import { formatJobType } from '../../utils/format'
import {
  JobBillingSummarySection,
  JobClientSection,
  JobCrewSection,
  JobDocumentsSection,
  JobInformationSection,
  JobNotesHistorySection,
  JobOpenBalancesBanner,
  JobSchedulesSection,
  JobSiteSection,
  JobTasksIssuesSection,
  JobTimeEntriesSection,
} from './jobDetailSections'

type Props = NativeStackScreenProps<JobsStackParamList, 'AdminJobDetail'>

const JOB_STATUS_OPTIONS = [
  'QUOTE',
  'SCHEDULED',
  'IN_PROGRESS',
  'MEASURED',
  'NEED_TO_ORDER',
  'ORDERED',
  'INSTALLATION_COMPLETE',
  'NEED_TOUCH_UPS',
  'FINISHING_COMPLETE',
  'COMPLETED',
  'ON_HOLD',
  'CANCELLED',
  'INVOICED',
]

function formatStatusLabel(status: string) {
  return status
    .replace('NEED_TO_ORDER', 'NEED TO ORDER')
    .replace('NEED_TOUCH_UPS', 'NEED TOUCH UPS')
    .replace('INSTALLATION_COMPLETE', 'INSTALLATION COMPLETED')
    .replace('FINISHING_COMPLETE', 'FINISHING COMPLETED')
    .replaceAll('_', ' ')
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

interface JobResponse {
  job: Job
}

interface JobTimeResponse {
  entries: TimeEntry[]
  activeEntries: TimeEntry[]
  summary: {
    totalMinutes: number
    billableHours: number
    billableAmountCents: number
  }
}

export function AdminJobDetailScreen({ route, navigation }: Props) {
  const { jobId } = route.params
  const queryClient = useQueryClient()
  const {
    canEditJobs,
    canAssignJobs,
    canScheduleJobs,
    canChangeJobStatus,
    canViewJobFinancials,
    canViewJobDocuments,
    canViewJobBilling,
    canViewJobTimeEntries,
    canViewJobNotes,
    canViewJobCrew,
    canViewJobSchedules,
    canViewJobClientDetails,
    canViewJobTasksIssues,
  } = useMobilePermissions()
  const [statusPickerVisible, setStatusPickerVisible] = useState(false)
  const [assignPickerVisible, setAssignPickerVisible] = useState(false)

  const jobQuery = useQuery({
    queryKey: ['admin-job', jobId],
    queryFn: () => apiRequest<JobResponse>(`/api/mobile/jobs/${jobId}`),
    refetchInterval: 45_000,
  })

  const timeQuery = useQuery({
    queryKey: ['admin-job-time', jobId],
    queryFn: () => apiRequest<JobTimeResponse>(`/api/jobs/${jobId}/time`),
    enabled: !!jobQuery.data?.job && canViewJobTimeEntries(),
    refetchInterval: 45_000,
  })

  const usersQuery = useQuery({
    queryKey: ['assignable-users', jobId],
    queryFn: () =>
      apiRequest<{
        users: Array<{
          id: string
          firstName: string
          lastName: string
          role: string
          status?: string | null
        }>
      }>('/api/users?limit=200'),
    enabled: assignPickerVisible,
  })

  const job = jobQuery.data?.job
  const assignments = asArray<NonNullable<Job['assignments']>[number]>(job?.assignments)

  const statusMutation = useMutation({
    mutationFn: async (status: string) => {
      await apiRequest(`/api/jobs/${jobId}`, 'PUT', { status })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-job', jobId] })
      queryClient.invalidateQueries({ queryKey: ['all-jobs'] })
      Alert.alert('Success', 'Job status updated')
    },
    onError: (error: any) => {
      Alert.alert('Error', error?.message || 'Failed to update status')
    },
  })

  const assignMutation = useMutation({
    mutationFn: async (userId: string) => {
      await apiRequest(`/api/jobs/${jobId}/assignments`, 'POST', { userId })
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-job', jobId] }),
        queryClient.invalidateQueries({ queryKey: ['all-jobs'] }),
        queryClient.invalidateQueries({ queryKey: ['mobile-assignments'] }),
      ])
      Alert.alert('Success', 'Crew member assigned to job.')
    },
    onError: (error: any) => {
      Alert.alert('Assignment failed', error?.message || 'Unable to assign crew member.')
    },
  })

  const onRefresh = async () => {
    await Promise.all([jobQuery.refetch(), timeQuery.refetch()])
  }

  if (jobQuery.isError) {
    return (
      <AppScreen>
        <View style={styles.centerContainer}>
          <Text style={styles.loadingText}>Unable to load job details.</Text>
          <Pressable style={styles.retryButton} onPress={() => jobQuery.refetch()}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      </AppScreen>
    )
  }

  if (!job) {
    return (
      <AppScreen>
        <View style={styles.centerContainer}>
          <Text style={styles.loadingText}>Loading job...</Text>
        </View>
      </AppScreen>
    )
  }

  const openMaps = () => {
    const site = job.jobSite || job.address
    if (!site?.street) return
    const fullAddress = `${site.street}, ${site.city || ''}, ${site.state || ''} ${site.zipCode || ''}`.trim()
    const encoded = encodeURIComponent(fullAddress)
    const googleMapsUrl = Platform.OS === 'android' ? `comgooglemaps://?q=${encoded}` : `googlemaps://?q=${encoded}`
    const webMapsUrl = `https://maps.google.com/?q=${encoded}`
    Linking.canOpenURL(googleMapsUrl)
      .then((supported) => (supported ? Linking.openURL(googleMapsUrl) : Linking.openURL(webMapsUrl)))
      .catch(() => Linking.openURL(webMapsUrl))
  }

  const callClient = () => {
    const phone = job.client?.phone || job.client?.contacts?.[0]?.phone
    if (!phone) {
      Alert.alert('No phone number', 'This client does not have a phone number on file.')
      return
    }
    Linking.openURL(`tel:${phone}`)
  }

  const assignedUserIds = new Set(assignments.map((entry) => entry.user.id))
  const assignableUsers = (usersQuery.data?.users || []).filter((entry) => {
    if (assignedUserIds.has(entry.id)) return false
    const status = String(entry.status || '').toUpperCase()
    if (status && status !== 'ACTIVE') return false
    const role = String(entry.role || '').toUpperCase()
    return role === 'ADMIN' || role === 'OFFICE' || role === 'FIELD'
  })

  return (
    <AppScreen>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        refreshControl={
          <RefreshControl refreshing={jobQuery.isRefetching || timeQuery.isRefetching} onRefresh={onRefresh} />
        }
      >
        {/* Header */}
        <View style={styles.headerCard}>
          <View style={styles.headerRow}>
            <View style={styles.headerText}>
              <Text style={styles.jobNumber}>{job.jobNumber}</Text>
              <Text style={styles.jobTitle}>{job.title}</Text>
            </View>
            <View style={styles.headerBadges}>
              <StatusBadge status={job.status} />
              <BillingStatusBadge status={job.billingStatus} />
            </View>
          </View>
          {job.jobType ? <Text style={styles.jobTypeBadge}>{formatJobType(job.jobType)}</Text> : null}
          <Text style={styles.clientName}>{job.client?.name || 'No client'}</Text>
          {canViewJobFinancials() ? <JobOpenBalancesBanner job={job} /> : null}

          <View style={styles.actionRow}>
            {!!(job.client?.phone || job.client?.contacts?.[0]?.phone) && (
              <Pressable style={styles.actionButton} onPress={callClient}>
                <Ionicons name="call-outline" size={20} color={colors.brandPrimary} />
                <Text style={styles.actionText}>Call</Text>
              </Pressable>
            )}
            {(job.jobSite?.street || job.address?.street) && (
              <Pressable style={styles.actionButton} onPress={openMaps}>
                <Ionicons name="map-outline" size={20} color={colors.brandPrimary} />
                <Text style={styles.actionText}>Maps</Text>
              </Pressable>
            )}
            {canEditJobs() && (
              <Pressable style={styles.actionButton} onPress={() => navigation.navigate('EditJob', { jobId })}>
                <Ionicons name="create-outline" size={20} color={colors.brandPrimary} />
                <Text style={styles.actionText}>Edit</Text>
              </Pressable>
            )}
            <Pressable
              style={styles.actionButton}
              onPress={() => {
                if (!canScheduleJobs()) {
                  Alert.alert('Permission denied', 'You do not have permission to schedule jobs.')
                  return
                }
                const rootNav: any = navigation.getParent()?.getParent() || navigation.getParent()
                rootNav?.navigate('MainTabs', {
                  screen: 'ScheduleTab',
                  params: {
                    screen: 'ScheduleCreate',
                    params: {
                      jobId: job.id,
                      assignedUserId: assignments[0]?.user?.id,
                      title: `${job.jobNumber} - ${job.title}`,
                    },
                  },
                })
              }}
            >
              <Ionicons name="calendar-outline" size={20} color={colors.brandPrimary} />
              <Text style={styles.actionText}>Schedule</Text>
            </Pressable>
          </View>
        </View>

        {/* Quick Actions / Status */}
        {canChangeJobStatus() && (
          <DetailSection title="Status">
            <Pressable
              style={styles.statusSelectTrigger}
              onPress={() => setStatusPickerVisible(true)}
              disabled={statusMutation.isPending}
            >
              <Text style={styles.statusSelectValue}>{formatStatusLabel(job.status)}</Text>
              <Ionicons name="chevron-down" size={18} color={colors.textPrimary} />
            </Pressable>
          </DetailSection>
        )}

        <JobInformationSection job={job} showFinancials={canViewJobFinancials()} />

        {canViewJobDocuments() ? <JobDocumentsSection job={job} /> : null}

        {canViewJobBilling() ? <JobBillingSummarySection job={job} /> : null}

        {canViewJobTimeEntries() ? (
          <JobTimeEntriesSection
            entries={asArray<TimeEntry>(timeQuery.data?.entries)}
            activeTimers={job.activeTimers}
            loading={timeQuery.isLoading}
          />
        ) : null}

        <JobSiteSection job={job} onOpenMaps={openMaps} />

        {canViewJobCrew() || canAssignJobs() ? (
          <JobCrewSection
            job={job}
            right={
              canAssignJobs() ? (
                <Pressable style={styles.assignButton} onPress={() => setAssignPickerVisible(true)}>
                  <Ionicons name="person-add-outline" size={18} color={colors.brandPrimary} />
                  <Text style={styles.assignButtonText}>Assign</Text>
                </Pressable>
              ) : undefined
            }
          />
        ) : null}

        {canViewJobNotes() ? <JobNotesHistorySection job={job} /> : null}

        {canViewJobClientDetails() ? <JobClientSection job={job} /> : null}

        {canViewJobTasksIssues() ? <JobTasksIssuesSection job={job} showLists /> : null}

        {canViewJobSchedules() ? <JobSchedulesSection job={job} /> : null}

        <Modal
          visible={statusPickerVisible}
          transparent
          animationType="fade"
          onRequestClose={() => setStatusPickerVisible(false)}
        >
          <View style={styles.modalBackdrop}>
            <Pressable style={StyleSheet.absoluteFill} onPress={() => setStatusPickerVisible(false)} />
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>Update Job Status</Text>
              <ScrollView style={{ maxHeight: 360 }}>
                {JOB_STATUS_OPTIONS.map((status) => {
                  const active = status === job.status
                  return (
                    <Pressable
                      key={status}
                      style={[styles.modalRow, active && styles.modalRowActive]}
                      onPress={() => {
                        setStatusPickerVisible(false)
                        if (active) return
                        statusMutation.mutate(status)
                      }}
                    >
                      <Text style={styles.modalRowTitle}>{formatStatusLabel(status)}</Text>
                      {active ? <Ionicons name="checkmark" size={18} color={colors.brandPrimary} /> : null}
                    </Pressable>
                  )
                })}
              </ScrollView>
            </View>
          </View>
        </Modal>

        <Modal
          visible={assignPickerVisible}
          transparent
          animationType="fade"
          onRequestClose={() => setAssignPickerVisible(false)}
        >
          <View style={styles.modalBackdrop}>
            <Pressable style={StyleSheet.absoluteFill} onPress={() => setAssignPickerVisible(false)} />
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>Assign Crew</Text>
              <ScrollView style={{ maxHeight: 360 }}>
                {usersQuery.isLoading ? <Text style={styles.emptyText}>Loading users...</Text> : null}
                {!usersQuery.isLoading && assignableUsers.length === 0 ? (
                  <Text style={styles.emptyText}>No available users to assign.</Text>
                ) : null}
                {assignableUsers.map((member) => (
                  <Pressable
                    key={member.id}
                    style={styles.modalRow}
                    disabled={assignMutation.isPending}
                    onPress={() => {
                      setAssignPickerVisible(false)
                      assignMutation.mutate(member.id)
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.modalRowTitle}>
                        {member.firstName} {member.lastName}
                      </Text>
                      <Text style={styles.modalRowMeta}>{member.role}</Text>
                    </View>
                    <Ionicons name="person-add-outline" size={18} color={colors.brandPrimary} />
                  </Pressable>
                ))}
              </ScrollView>
              <Pressable style={styles.modalCloseButton} onPress={() => setAssignPickerVisible(false)}>
                <Text style={styles.modalCloseText}>Close</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      </ScrollView>
    </AppScreen>
  )
}

const styles = StyleSheet.create({
  scrollView: { flex: 1 },
  scrollContent: { padding: spacing.md, paddingBottom: spacing.xxl },
  centerContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.sm,
  },
  loadingText: {
    ...typography.sub,
    color: colors.textSecondary,
  },
  retryButton: {
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  retryText: {
    ...typography.sub,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  headerCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.divider,
    padding: spacing.md,
    marginBottom: spacing.md,
    gap: spacing.xs,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  headerText: {
    flex: 1,
    marginRight: spacing.sm,
  },
  headerBadges: {
    alignItems: 'flex-end',
    gap: 4,
  },
  jobNumber: {
    ...typography.caption,
    color: colors.textSecondary,
    marginBottom: 2,
  },
  jobTitle: {
    ...typography.h3,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  jobTypeBadge: {
    alignSelf: 'flex-start',
    backgroundColor: '#EEF2FF',
    color: '#3730A3',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    fontSize: 11,
    fontWeight: '700',
    overflow: 'hidden',
    textTransform: 'uppercase',
  },
  clientName: {
    ...typography.sub,
    color: colors.textPrimary,
  },
  actionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.brandPrimary,
  },
  actionText: {
    ...typography.caption,
    color: colors.brandPrimary,
    fontWeight: '600',
  },
  statusSelectTrigger: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  statusSelectValue: {
    ...typography.sub,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  assignButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.brandPrimary,
  },
  assignButtonText: {
    ...typography.caption,
    color: colors.brandPrimary,
    fontWeight: '600',
  },
  emptyText: {
    ...typography.caption,
    color: colors.textSecondary,
    fontStyle: 'italic',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(2,6,23,0.45)',
    justifyContent: 'center',
    padding: spacing.md,
  },
  modalCard: {
    borderRadius: 14,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.divider,
    padding: spacing.sm,
  },
  modalTitle: {
    ...typography.h3,
    color: colors.textPrimary,
    marginBottom: spacing.xs,
  },
  modalRow: {
    minHeight: 46,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  modalRowActive: {
    backgroundColor: 'rgba(15,76,92,0.1)',
  },
  modalRowTitle: {
    ...typography.sub,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  modalRowMeta: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: 2,
  },
  modalCloseButton: {
    marginTop: spacing.md,
    alignSelf: 'flex-end',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.divider,
  },
  modalCloseText: {
    ...typography.sub,
    color: colors.textPrimary,
    fontWeight: '600',
  },
})
