import React, { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  FlatList,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { NativeStackScreenProps } from '@react-navigation/native-stack'
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Ionicons } from '@expo/vector-icons'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { AppScreen } from '../../components/AppScreen'
import { apiRequest } from '../../api/client'
import { colors, spacing, typography } from '../../theme/tokens'
import { Card } from '../../components/Card'
import { useAuth } from '../../auth/AuthContext'
import { useMobilePermissions } from '../../hooks/useMobilePermissions'
import { ScheduleStackParamList } from '../../types/navigation'

type Props = NativeStackScreenProps<ScheduleStackParamList, 'ScheduleCreate'>

interface TeamMembersResponse {
  teamMembers: Array<{ id: string; firstName: string; lastName: string; role?: string | null }>
}

interface JobsResponse {
  jobs: Array<{
    id: string
    jobNumber: string
    title: string
    status?: string
    clientName?: string
    client?: { companyName?: string; name?: string }
  }>
}

interface ScheduleDetailResponse {
  schedule: {
    id: string
    title: string
    description: string | null
    type: string
    startTime: string
    endTime: string
    userId: string
    jobId: string | null
    leadId?: string | null
  }
}

export function ScheduleCreateScreen({ navigation, route }: Props) {
  const scheduleId = route.params?.scheduleId
  const prefillJobId = route.params?.jobId
  const prefillLeadId = route.params?.leadId
  const prefillAssignedUserId = route.params?.assignedUserId
  const prefillTitle = route.params?.title
  const prefillDescription = route.params?.description
  const isEdit = Boolean(scheduleId)
  const { user } = useAuth()
  const { canCreateSchedulesForOthers, canAssignJobs } = useMobilePermissions()
  const queryClient = useQueryClient()
  const insets = useSafeAreaInsets()

  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [type, setType] = useState<'OTHER' | 'JOB' | 'MEETING' | 'FOLLOW_UP'>('OTHER')
  const [assignedUserId, setAssignedUserId] = useState('')
  const [linkToJob, setLinkToJob] = useState(false)
  const [jobId, setJobId] = useState('')
  const [leadId, setLeadId] = useState('')
  const [startAt, setStartAt] = useState<Date>(new Date())
  const [endAt, setEndAt] = useState<Date>(() => new Date(Date.now() + 60 * 60 * 1000))
  const [iosPicker, setIosPicker] = useState<{ mode: 'date' | 'time'; target: 'start' | 'end' } | null>(null)
  const [assignedPickerOpen, setAssignedPickerOpen] = useState(false)
  const [assignedSearch, setAssignedSearch] = useState('')
  const [jobPickerOpen, setJobPickerOpen] = useState(false)
  const [jobSearch, setJobSearch] = useState('')

  const teamQuery = useQuery({
    queryKey: ['mobile-schedule-team-create'],
    queryFn: () => apiRequest<TeamMembersResponse>('/api/schedules/team'),
  })

  const jobsQuery = useQuery({
    queryKey: ['mobile-schedule-jobs-create'],
    queryFn: () => apiRequest<JobsResponse>('/api/mobile/jobs?limit=100&filter=assigned'),
  })

  const detailQuery = useQuery({
    queryKey: ['mobile-schedule-edit', scheduleId],
    queryFn: () => apiRequest<ScheduleDetailResponse>(`/api/schedules/${scheduleId}`),
    enabled: Boolean(scheduleId),
  })

  useEffect(() => {
    if (user?.id && !assignedUserId) {
      setAssignedUserId(user.id)
    }
  }, [assignedUserId, user?.id])

  useEffect(() => {
    if (!detailQuery.data?.schedule) return
    const s = detailQuery.data.schedule
    setTitle(s.title || '')
    setNotes(s.description || '')
    setType((s.type as any) || 'OTHER')
    setAssignedUserId(s.userId || user?.id || '')
    setJobId(s.jobId || '')
    setLeadId((s as any).leadId || '')
    setLinkToJob(Boolean(s.jobId) || s.type === 'JOB')
    setStartAt(new Date(s.startTime))
    setEndAt(new Date(s.endTime))
  }, [detailQuery.data?.schedule, user?.id])

  useEffect(() => {
    if (isEdit) return
    if (prefillJobId) {
      setType('JOB')
      setLinkToJob(true)
      setJobId(prefillJobId)
    }
    if (prefillLeadId) {
      setLeadId(prefillLeadId)
    }
    if (prefillAssignedUserId) {
      setAssignedUserId(prefillAssignedUserId)
    }
    if (prefillTitle && !title.trim()) {
      setTitle(prefillTitle)
    }
    if (prefillDescription && !notes.trim()) {
      setNotes(prefillDescription)
    }
  }, [isEdit, notes, prefillAssignedUserId, prefillDescription, prefillJobId, prefillLeadId, prefillTitle, title])

  useEffect(() => {
    if (type === 'JOB') {
      setLinkToJob(true)
    }
  }, [type])

  const allowedAssignedUserId = useMemo(() => {
    if (canCreateSchedulesForOthers()) return assignedUserId || user?.id || ''
    return user?.id || ''
  }, [assignedUserId, canCreateSchedulesForOthers, user?.id])

  const teamMembers = teamQuery.data?.teamMembers || []
  const canAssignOthers = canCreateSchedulesForOthers() || canAssignJobs()
  const selectedMember = teamMembers.find((member) => member.id === allowedAssignedUserId)
  const selectedJob = (jobsQuery.data?.jobs || []).find((job) => job.id === jobId)

  const filteredMembers = useMemo(() => {
    const search = assignedSearch.trim().toLowerCase()
    const rows = canAssignOthers ? teamMembers : teamMembers.filter((member) => member.id === user?.id)
    if (!search) return rows
    return rows.filter((member) => {
      const fullName = `${member.firstName} ${member.lastName}`.toLowerCase()
      const role = String(member.role || '').toLowerCase()
      return fullName.includes(search) || role.includes(search)
    })
  }, [assignedSearch, canAssignOthers, teamMembers, user?.id])

  const filteredJobs = useMemo(() => {
    const search = jobSearch.trim().toLowerCase()
    const rows = jobsQuery.data?.jobs || []
    if (!search) return rows
    return rows.filter((job) => {
      const clientName = job.clientName || job.client?.companyName || job.client?.name || ''
      return (
        String(job.jobNumber || '').toLowerCase().includes(search) ||
        String(job.title || '').toLowerCase().includes(search) ||
        String(clientName).toLowerCase().includes(search) ||
        String(job.status || '').toLowerCase().includes(search)
      )
    })
  }, [jobSearch, jobsQuery.data?.jobs])

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        title: title.trim(),
        description: notes.trim() || null,
        type,
        startTime: startAt.toISOString(),
        endTime: endAt.toISOString(),
        assignedUserId: allowedAssignedUserId,
        jobId: linkToJob ? jobId || null : null,
        leadId: leadId || null,
      }
      if (__DEV__) console.debug('[schedule] submit', { isEdit, payload })
      if (isEdit && scheduleId) {
        return apiRequest<{ schedule: { id: string } }>(`/api/schedules/${scheduleId}`, 'PUT', payload)
      }
      return apiRequest<{ schedule: { id: string } }>('/api/schedules', 'POST', payload)
    },
    onSuccess: (data) => {
      const createdId = data.schedule?.id || scheduleId
      void queryClient.invalidateQueries({ queryKey: ['mobile-schedule'] })
      Alert.alert('Success', isEdit ? 'Schedule updated.' : 'Schedule created.')
      if (createdId) {
        navigation.replace('ScheduleDetail', { scheduleId: createdId })
      } else {
        navigation.navigate('ScheduleHome')
      }
    },
    onError: (error: any) => {
      if (__DEV__) console.debug('[schedule] save error', error)
      Alert.alert('Save failed', error?.message || 'Unable to save schedule.')
    },
  })

  const openPicker = (mode: 'date' | 'time', target: 'start' | 'end') => {
    if (Platform.OS === 'ios') {
      setIosPicker({ mode, target })
      return
    }
    DateTimePickerAndroid.open({
      mode,
      value: target === 'start' ? startAt : endAt,
      onChange: (_event, value) => {
        if (!value) return
        const current = target === 'start' ? startAt : endAt
        const next = new Date(current)
        if (mode === 'date') {
          next.setFullYear(value.getFullYear(), value.getMonth(), value.getDate())
        } else {
          next.setHours(value.getHours(), value.getMinutes(), 0, 0)
        }
        if (target === 'start') setStartAt(next)
        else setEndAt(next)
      },
    })
  }

  const footerSpace = 90 + Math.max(insets.bottom, spacing.sm)

  return (
    <AppScreen>
      <View style={styles.root}>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: footerSpace }]}>
        <Card>
          <Text style={styles.sectionTitle}>{isEdit ? 'Edit Schedule' : 'New Schedule'}</Text>
          <View style={styles.field}>
            <Text style={styles.label}>Title</Text>
            <TextInput value={title} onChangeText={setTitle} placeholder="Schedule title" style={styles.input} />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Notes</Text>
            <TextInput
              value={notes}
              onChangeText={setNotes}
              placeholder="Add details"
              style={[styles.input, styles.notesInput]}
              multiline
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Assigned to</Text>
            <Pressable
              disabled={!canAssignOthers}
              onPress={() => setAssignedPickerOpen(true)}
              style={[styles.pickerTrigger, !canAssignOthers && styles.pickerTriggerDisabled]}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.pickerValue}>
                  {selectedMember ? `${selectedMember.firstName} ${selectedMember.lastName}` : 'Select team member'}
                </Text>
                {selectedMember?.role ? <Text style={styles.pickerMeta}>{selectedMember.role}</Text> : null}
                {!canAssignOthers ? <Text style={styles.pickerMeta}>Assigned to your account only</Text> : null}
              </View>
              {canAssignOthers ? <Ionicons name="chevron-down" size={18} color={colors.textSecondary} /> : null}
            </Pressable>
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Type</Text>
            <View style={styles.segmentedWrap}>
              {(['OTHER', 'JOB', 'MEETING', 'FOLLOW_UP'] as const).map((item) => {
                const selected = item === type
                return (
                  <Pressable key={item} onPress={() => setType(item)} style={[styles.segmentButton, selected && styles.segmentButtonActive]}>
                    <Text style={[styles.segmentText, selected && styles.segmentTextActive]}>{item.replace('_', ' ')}</Text>
                  </Pressable>
                )
              })}
            </View>
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Start</Text>
            <View style={styles.dateTimeRow}>
              <Pressable style={styles.timeButton} onPress={() => openPicker('date', 'start')}>
                <Text style={styles.timeText}>{startAt.toLocaleDateString()}</Text>
              </Pressable>
              <Pressable style={styles.timeButton} onPress={() => openPicker('time', 'start')}>
                <Text style={styles.timeText}>{startAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</Text>
              </Pressable>
            </View>
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>End</Text>
            <View style={styles.dateTimeRow}>
              <Pressable style={styles.timeButton} onPress={() => openPicker('date', 'end')}>
                <Text style={styles.timeText}>{endAt.toLocaleDateString()}</Text>
              </Pressable>
              <Pressable style={styles.timeButton} onPress={() => openPicker('time', 'end')}>
                <Text style={styles.timeText}>{endAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</Text>
              </Pressable>
            </View>
          </View>

          <View style={styles.field}>
            <View style={styles.toggleRow}>
              <Text style={styles.label}>Link to job</Text>
              <Pressable
                onPress={() => {
                  const next = !linkToJob
                  setLinkToJob(next)
                  if (!next && type !== 'JOB') setJobId('')
                }}
                style={[styles.toggle, linkToJob && styles.toggleOn]}
              >
                <View style={[styles.toggleKnob, linkToJob && styles.toggleKnobOn]} />
              </Pressable>
            </View>
            {linkToJob ? (
              <Pressable onPress={() => setJobPickerOpen(true)} style={styles.pickerTrigger}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.pickerValue}>
                    {selectedJob ? `${selectedJob.jobNumber} - ${selectedJob.title}` : 'Select a job'}
                  </Text>
                  {selectedJob?.status || selectedJob?.clientName || selectedJob?.client?.companyName ? (
                    <Text style={styles.pickerMeta}>
                      {[selectedJob.status, selectedJob.clientName || selectedJob.client?.companyName].filter(Boolean).join(' • ')}
                    </Text>
                  ) : null}
                </View>
                <Ionicons name="chevron-down" size={18} color={colors.textSecondary} />
              </Pressable>
            ) : null}
          </View>
        </Card>

        {iosPicker ? (
          <View style={styles.iosPickerWrap}>
            <DateTimePicker
              value={iosPicker.target === 'start' ? startAt : endAt}
              mode={iosPicker.mode}
              display="spinner"
              onChange={(_event, value) => {
                if (!value) return
                const current = iosPicker.target === 'start' ? startAt : endAt
                const next = new Date(current)
                if (iosPicker.mode === 'date') {
                  next.setFullYear(value.getFullYear(), value.getMonth(), value.getDate())
                } else {
                  next.setHours(value.getHours(), value.getMinutes(), 0, 0)
                }
                if (iosPicker.target === 'start') setStartAt(next)
                else setEndAt(next)
              }}
            />
            <Pressable style={styles.iosDoneButton} onPress={() => setIosPicker(null)}>
              <Text style={styles.iosDoneText}>Done</Text>
            </Pressable>
          </View>
        ) : null}
      </ScrollView>
      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
        <Pressable
          style={[styles.saveButton, saveMutation.isPending && { opacity: 0.7 }]}
          disabled={saveMutation.isPending || !title.trim()}
          onPress={() => {
            if (endAt <= startAt) {
              Alert.alert('Invalid time', 'End time must be after start time.')
              return
            }
            if ((type === 'JOB' || linkToJob) && !jobId) {
              Alert.alert('Job required', 'Please select a job for this schedule.')
              return
            }
            saveMutation.mutate()
          }}
        >
          <Text style={styles.saveText}>{saveMutation.isPending ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Schedule'}</Text>
        </Pressable>
      </View>
      </View>

      <Modal visible={assignedPickerOpen} transparent animationType="fade" onRequestClose={() => setAssignedPickerOpen(false)}>
        <View style={styles.modalBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setAssignedPickerOpen(false)} />
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Assigned to</Text>
            <TextInput
              value={assignedSearch}
              onChangeText={setAssignedSearch}
              placeholder="Search team members"
              style={styles.searchInput}
            />
            <FlatList
              data={filteredMembers}
              keyExtractor={(item) => item.id}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => {
                const active = item.id === allowedAssignedUserId
                return (
                  <Pressable
                    onPress={() => {
                      setAssignedUserId(item.id)
                      setAssignedPickerOpen(false)
                    }}
                    style={[styles.modalRow, active && styles.modalRowActive]}
                  >
                    <View style={styles.initialsBubble}>
                      <Text style={styles.initialsText}>
                        {(item.firstName?.[0] || '').toUpperCase()}
                        {(item.lastName?.[0] || '').toUpperCase()}
                      </Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.modalRowTitle}>
                        {item.firstName} {item.lastName}
                      </Text>
                      {item.role ? <Text style={styles.modalRowMeta}>{item.role}</Text> : null}
                    </View>
                    {active ? <Ionicons name="checkmark" size={18} color={colors.brandPrimary} /> : null}
                  </Pressable>
                )
              }}
              ListEmptyComponent={<Text style={styles.emptyText}>No team members found.</Text>}
            />
          </View>
        </View>
      </Modal>

      <Modal visible={jobPickerOpen} transparent animationType="fade" onRequestClose={() => setJobPickerOpen(false)}>
        <View style={styles.modalBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setJobPickerOpen(false)} />
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Select job</Text>
            <TextInput value={jobSearch} onChangeText={setJobSearch} placeholder="Search jobs" style={styles.searchInput} />
            <FlatList
              data={filteredJobs}
              keyExtractor={(item) => item.id}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => {
                const active = item.id === jobId
                const clientName = item.clientName || item.client?.companyName || item.client?.name
                return (
                  <Pressable
                    onPress={() => {
                      setJobId(item.id)
                      setJobPickerOpen(false)
                    }}
                    style={[styles.modalRow, active && styles.modalRowActive]}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.modalRowTitle}>
                        {item.jobNumber} - {item.title}
                      </Text>
                      {(item.status || clientName) ? (
                        <Text style={styles.modalRowMeta}>{[clientName, item.status].filter(Boolean).join(' • ')}</Text>
                      ) : null}
                    </View>
                    {active ? <Ionicons name="checkmark" size={18} color={colors.brandPrimary} /> : null}
                  </Pressable>
                )
              }}
              ListEmptyComponent={<Text style={styles.emptyText}>No jobs match your search.</Text>}
            />
          </View>
        </View>
      </Modal>
    </AppScreen>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { gap: spacing.sm, paddingTop: spacing.sm },
  sectionTitle: { ...typography.h3, color: colors.textPrimary, marginBottom: spacing.xs },
  field: { marginTop: spacing.sm },
  label: { ...typography.caption, color: colors.textSecondary, marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: 10,
    minHeight: 42,
    paddingHorizontal: spacing.sm,
    color: colors.textPrimary,
    backgroundColor: colors.surface,
  },
  notesInput: { minHeight: 90, paddingTop: spacing.sm, textAlignVertical: 'top' },
  pickerTrigger: {
    minHeight: 46,
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: 12,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  pickerTriggerDisabled: { opacity: 0.75 },
  pickerValue: { ...typography.sub, color: colors.textPrimary, fontWeight: '600' },
  pickerMeta: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  segmentedWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: 12,
    padding: spacing.xs,
    backgroundColor: colors.surface,
  },
  segmentButton: {
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: 999,
    minHeight: 34,
    paddingHorizontal: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
  segmentButtonActive: { borderColor: colors.brandPrimary, backgroundColor: 'rgba(15,76,92,0.14)' },
  segmentText: { ...typography.caption, color: colors.textSecondary, fontWeight: '600' },
  segmentTextActive: { color: colors.brandPrimary },
  dateTimeRow: { flexDirection: 'row', gap: spacing.sm },
  timeButton: {
    flex: 1,
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  timeText: { ...typography.caption, color: colors.textPrimary, fontWeight: '600' },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  toggle: {
    width: 46,
    height: 28,
    borderRadius: 999,
    backgroundColor: colors.muted,
    padding: 3,
    justifyContent: 'center',
  },
  toggleOn: { backgroundColor: colors.brandPrimary },
  toggleKnob: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.surface,
  },
  toggleKnobOn: { alignSelf: 'flex-end' },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    backgroundColor: colors.background,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  saveButton: {
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: colors.brandPrimary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveText: { ...typography.sub, color: '#fff', fontWeight: '700' },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(2,6,23,0.45)',
    justifyContent: 'center',
    padding: spacing.md,
  },
  modalCard: {
    maxHeight: '80%',
    borderRadius: 14,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.divider,
    padding: spacing.sm,
    gap: spacing.xs,
  },
  modalTitle: { ...typography.h3, color: colors.textPrimary, fontSize: 18 },
  searchInput: {
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: 10,
    minHeight: 40,
    paddingHorizontal: spacing.sm,
    color: colors.textPrimary,
    backgroundColor: colors.background,
  },
  modalRow: {
    minHeight: 54,
    borderRadius: 10,
    paddingHorizontal: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  modalRowActive: { backgroundColor: 'rgba(15,76,92,0.1)' },
  initialsBubble: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(15,76,92,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  initialsText: { ...typography.caption, color: colors.brandPrimary, fontWeight: '700' },
  modalRowTitle: { ...typography.sub, color: colors.textPrimary, fontWeight: '600' },
  modalRowMeta: { ...typography.caption, color: colors.textSecondary, marginTop: 1 },
  emptyText: { ...typography.caption, color: colors.textSecondary, textAlign: 'center', paddingVertical: spacing.md },
  iosPickerWrap: {
    marginTop: spacing.sm,
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: 12,
    backgroundColor: colors.surface,
    padding: spacing.xs,
  },
  iosDoneButton: {
    alignSelf: 'flex-end',
    minHeight: 36,
    minWidth: 80,
    paddingHorizontal: spacing.sm,
    borderRadius: 8,
    backgroundColor: colors.brandPrimary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iosDoneText: { ...typography.caption, color: '#fff', fontWeight: '700' },
})

