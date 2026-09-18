import React, { useCallback, useMemo, useState } from 'react'
import { Alert, FlatList, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useFocusEffect } from '@react-navigation/native'
import { NativeStackScreenProps } from '@react-navigation/native-stack'
import { Ionicons } from '@expo/vector-icons'
import { AppScreen } from '../../components/AppScreen'
import { apiRequest } from '../../api/client'
import { Task } from '../../types/models'
import { TasksStackParamList } from '../../types/navigation'
import { colors, spacing, typography } from '../../theme/tokens'
import { EmptyState } from '../../components/EmptyState'
import { PressableCard } from '../../components/Card'
import { StatusBadge } from '../../components/StatusBadge'
import { SectionHeader } from '../../components/SectionHeader'
import { useMobilePermissions } from '../../hooks/useMobilePermissions'
import { useAuth } from '../../auth/AuthContext'
import {
  convertTaskDraftToRequestDraft,
  deleteTaskDraft,
  isTaskDraftReady,
  listTaskDrafts,
  LocalTaskDraft,
  setTaskDraftPublishState,
  upsertTaskDraft,
} from '../../drafts/storage'
import { combineDateAndTime, formatScheduledAt, splitDateAndTime } from '../../utils/schedule'
import { useOnlineState } from '../../hooks/useOnlineState'

interface TasksResponse {
  tasks: Task[]
}

interface ClientListResponse {
  clients: Array<{
    id: string
    name: string
    companyName?: string | null
  }>
}

type Props = NativeStackScreenProps<TasksStackParamList, 'TasksList'>

export function TasksScreen({ navigation }: Props) {
  const { canCreateTasks, canAssignTasksToAdmin, canViewAllTasks } = useMobilePermissions()
  const { user } = useAuth()
  const isOnline = useOnlineState()
  const queryClient = useQueryClient()
  const [taskFilter, setTaskFilter] = useState<'all' | 'my' | 'assigned'>('my')
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null)
  const [taskDrafts, setTaskDrafts] = useState<LocalTaskDraft[]>([])
  const [taskTitle, setTaskTitle] = useState('')
  const [taskDescription, setTaskDescription] = useState('')
  const [taskNotes, setTaskNotes] = useState('')
  const [taskClientId, setTaskClientId] = useState<string | null>(null)
  const [taskClientName, setTaskClientName] = useState<string | null>(null)
  const [clientSearch, setClientSearch] = useState('')
  const [showClientPicker, setShowClientPicker] = useState(false)
  const [taskDate, setTaskDate] = useState<Date | null>(null)
  const [taskTime, setTaskTime] = useState<Date | null>(null)
  const [showDatePicker, setShowDatePicker] = useState(false)
  const [showTimePicker, setShowTimePicker] = useState(false)

  const reloadDrafts = useCallback(async () => {
    setTaskDrafts(await listTaskDrafts())
  }, [])

  useFocusEffect(
    useCallback(() => {
      void reloadDrafts()
      return () => {}
    }, [reloadDrafts])
  )

  const resetForm = useCallback(() => {
    setEditingDraftId(null)
    setTaskTitle('')
    setTaskDescription('')
    setTaskNotes('')
    setTaskClientId(null)
    setTaskClientName(null)
    setClientSearch('')
    setShowClientPicker(false)
    setTaskDate(null)
    setTaskTime(null)
    setShowDatePicker(false)
    setShowTimePicker(false)
    setShowCreateForm(false)
  }, [])

  const loadDraftIntoForm = useCallback((draft: LocalTaskDraft) => {
    const split = splitDateAndTime(draft.scheduledAt)
    setEditingDraftId(draft.id)
    setTaskTitle(draft.title)
    setTaskDescription(draft.description)
    setTaskNotes(draft.notes)
    setTaskClientId(draft.selectedClientId || null)
    setTaskClientName(draft.selectedClientName || null)
    setTaskDate(split.date)
    setTaskTime(split.time)
    setShowCreateForm(true)
  }, [])

  const clientsQuery = useQuery({
    queryKey: ['mobile-task-clients', clientSearch],
    queryFn: () =>
      apiRequest<ClientListResponse>(
        `/api/clients?status=active&limit=100&search=${encodeURIComponent(clientSearch.trim())}`
      ),
    enabled: showClientPicker,
  })

  const clientRows = useMemo(() => clientsQuery.data?.clients || [], [clientsQuery.data?.clients])

  const effectiveFilter =
    taskFilter === 'all' && !canViewAllTasks() ? 'my' : taskFilter

  const query = useQuery({
    queryKey: ['mobile-tasks', effectiveFilter],
    queryFn: () => apiRequest<TasksResponse>(`/api/tasks?filter=${effectiveFilter}&limit=100`),
    refetchInterval: 60_000,
  })

  const filterLabel =
    effectiveFilter === 'all'
      ? 'All Tasks'
      : effectiveFilter === 'my'
        ? 'My Tasks'
        : 'Assigned to Me'

  const publishTaskMutation = useMutation({
    mutationFn: async (draft: LocalTaskDraft) => {
      if (!user?.id) {
        throw new Error('Unable to determine current user')
      }
      if (!isOnline) {
        throw new Error('Reconnect before publishing this task.')
      }

      let assigneeId = user.id

      if (canAssignTasksToAdmin()) {
        const usersResponse = await apiRequest<{ users: Array<{ id: string; role: string; firstName: string; lastName: string }> }>(
          '/api/users?role=ADMIN&limit=10'
        )
        const adminUsers = usersResponse.users.filter((u) => u.role === 'ADMIN' || u.role === 'OFFICE')
        if (adminUsers.length > 0) {
          assigneeId = adminUsers[0].id
        }
      }

      const descriptionWithNotes = [draft.description.trim(), draft.notes.trim() ? `Notes:\n${draft.notes.trim()}` : '']
        .filter(Boolean)
        .join('\n\n')

      await setTaskDraftPublishState(draft.id, 'pendingPublish')

      return apiRequest('/api/tasks?mobile=true', 'POST', {
        title: draft.title.trim(),
        description: descriptionWithNotes || null,
        assigneeId,
        priority: 'MEDIUM',
        status: 'TODO',
        dueDate: draft.scheduledAt,
        clientId: draft.selectedClientId || null,
      })
    },
    onSuccess: async (_result, draft) => {
      await deleteTaskDraft(draft.id)
      await reloadDrafts()
      queryClient.invalidateQueries({ queryKey: ['mobile-tasks'] })
      queryClient.invalidateQueries({ queryKey: ['mobile-assignments'] })
      Alert.alert('Published', 'Task uploaded successfully.')
    },
    onError: async (error: any, draft) => {
      await setTaskDraftPublishState(draft.id, 'publishFailed', error?.message || 'Failed to publish task')
      await reloadDrafts()
      Alert.alert('Publish failed', error?.message || 'Failed to publish task')
    },
  })

  const saveLocalDraft = useMutation({
    mutationFn: async () => {
      if (!taskTitle.trim()) {
        throw new Error('Task title is required.')
      }
      return upsertTaskDraft({
        id: editingDraftId || undefined,
        title: taskTitle,
        description: taskDescription,
        notes: taskNotes,
        selectedClientId: taskClientId,
        selectedClientName: taskClientName,
        scheduledAt: combineDateAndTime(taskDate, taskTime),
        publishState: isTaskDraftReady({ title: taskTitle }) ? 'readyToPublish' : 'localDraft',
        publishError: null,
      })
    },
    onSuccess: async () => {
      await reloadDrafts()
      resetForm()
      Alert.alert('Saved locally', 'Task draft is stored on this phone until you publish it.')
    },
    onError: (error: any) => {
      Alert.alert('Unable to save', error?.message || 'Task draft could not be saved locally.')
    },
  })

  const onConvertDraft = useCallback(
    async (draft: LocalTaskDraft) => {
      try {
        const requestDraft = await convertTaskDraftToRequestDraft(draft.id)
        await reloadDrafts()
        const tabsNav = navigation.getParent() as any
        tabsNav?.navigate('JobsTab', {
          screen: 'RequestCreate',
          params: { draftId: requestDraft.id },
        })
      } catch (error: any) {
        Alert.alert('Conversion failed', error?.message || 'Unable to convert task draft to request.')
      }
    },
    [navigation, reloadDrafts]
  )

  const onDeleteDraft = useCallback(
    (draft: LocalTaskDraft) => {
      Alert.alert('Delete local draft', 'Remove this unpublished task draft from this phone?', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void deleteTaskDraft(draft.id).then(reloadDrafts)
          },
        },
      ])
    },
    [reloadDrafts]
  )

  const localDrafts = taskDrafts
  const publishedTasks = query.data?.tasks ?? []

  return (
    <AppScreen>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.title}>Tasks</Text>
            <Text style={styles.subtitle}>Same filters as the web Tasks page.</Text>
          </View>
          {canCreateTasks() && (
            <Pressable
              style={styles.createButton}
              onPress={() => {
                if (showCreateForm) {
                  resetForm()
                  return
                }
                setShowCreateForm(true)
              }}
              disabled={saveLocalDraft.isPending}
            >
              <Ionicons name="add" size={24} color="#E6C98B" />
            </Pressable>
          )}
        </View>
        <View style={styles.filterRow}>
          {canViewAllTasks() ? (
            <Pressable
              style={[styles.filterChip, effectiveFilter === 'all' && styles.filterChipActive]}
              onPress={() => setTaskFilter('all')}
            >
              <Text style={[styles.filterChipText, effectiveFilter === 'all' && styles.filterChipTextActive]}>
                All Tasks
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            style={[styles.filterChip, effectiveFilter === 'my' && styles.filterChipActive]}
            onPress={() => setTaskFilter('my')}
          >
            <Text style={[styles.filterChipText, effectiveFilter === 'my' && styles.filterChipTextActive]}>
              My Tasks
            </Text>
          </Pressable>
          <Pressable
            style={[styles.filterChip, effectiveFilter === 'assigned' && styles.filterChipActive]}
            onPress={() => setTaskFilter('assigned')}
          >
            <Text style={[styles.filterChipText, effectiveFilter === 'assigned' && styles.filterChipTextActive]}>
              Assigned to Me
            </Text>
          </Pressable>
        </View>
      </View>
      {showCreateForm && (
        <View style={styles.formCard}>
          <Text style={styles.formTitle}>{editingDraftId ? 'Edit Local Task Draft' : 'Create Local Task Draft'}</Text>
          <TextInput
            style={styles.input}
            placeholder="Title"
            placeholderTextColor={colors.textPrimary}
            selectionColor={colors.textPrimary}
            cursorColor={colors.textPrimary}
            value={taskTitle}
            onChangeText={setTaskTitle}
          />
          <TextInput
            style={[styles.input, styles.multilineInput]}
            placeholder="Description"
            placeholderTextColor={colors.textPrimary}
            selectionColor={colors.textPrimary}
            cursorColor={colors.textPrimary}
            value={taskDescription}
            onChangeText={setTaskDescription}
            multiline
          />
          <TextInput
            style={[styles.input, styles.multilineInput]}
            placeholder="Notes"
            placeholderTextColor={colors.textPrimary}
            selectionColor={colors.textPrimary}
            cursorColor={colors.textPrimary}
            value={taskNotes}
            onChangeText={setTaskNotes}
            multiline
          />
          <Pressable style={styles.clientSelectButton} onPress={() => setShowClientPicker(true)}>
            <Ionicons name="people-outline" size={16} color={colors.textSecondary} />
            <Text style={taskClientName ? styles.clientSelectValue : styles.clientSelectPlaceholder}>
              {taskClientName || 'Client · Optional'}
            </Text>
            {taskClientId ? (
              <Pressable
                onPress={() => {
                  setTaskClientId(null)
                  setTaskClientName(null)
                }}
                hitSlop={8}
              >
                <Ionicons name="close-circle" size={16} color={colors.textSecondary} />
              </Pressable>
            ) : (
              <Ionicons name="chevron-down" size={16} color={colors.textSecondary} />
            )}
          </Pressable>

          <Pressable
            style={styles.datePickerButton}
            onPress={() => {
              if (Platform.OS === 'android') {
                DateTimePickerAndroid.open({
                  value: taskDate ?? new Date(),
                  mode: 'date',
                  onChange: (_e, d) => {
                    if (d) setTaskDate(d)
                  },
                })
              } else {
                setShowDatePicker(!showDatePicker)
              }
            }}
          >
            <Ionicons name="calendar-outline" size={16} color={colors.textSecondary} />
            <Text style={styles.datePickerText}>
              {taskDate
                ? taskDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                : 'Date · Optional / Unscheduled'}
            </Text>
            {taskDate ? (
              <Pressable onPress={() => setTaskDate(null)} hitSlop={8}>
                <Ionicons name="close-circle" size={16} color={colors.textSecondary} />
              </Pressable>
            ) : null}
          </Pressable>
          {Platform.OS === 'ios' && showDatePicker ? (
            <DateTimePicker
              value={taskDate ?? new Date()}
              mode="date"
              display="spinner"
              onChange={(_e, d) => {
                if (d) setTaskDate(d)
              }}
            />
          ) : null}
          <Pressable
            style={styles.datePickerButton}
            onPress={() => {
              if (Platform.OS === 'android') {
                DateTimePickerAndroid.open({
                  value: taskTime ?? new Date(),
                  mode: 'time',
                  onChange: (_e, d) => {
                    if (d) setTaskTime(d)
                  },
                })
              } else {
                setShowTimePicker(!showTimePicker)
              }
            }}
          >
            <Ionicons name="time-outline" size={16} color={colors.textSecondary} />
            <Text style={styles.datePickerText}>
              {taskTime
                ? taskTime.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
                : 'Time · Optional / Unscheduled'}
            </Text>
            {taskTime ? (
              <Pressable onPress={() => setTaskTime(null)} hitSlop={8}>
                <Ionicons name="close-circle" size={16} color={colors.textSecondary} />
              </Pressable>
            ) : null}
          </Pressable>
          {Platform.OS === 'ios' && showTimePicker ? (
            <DateTimePicker
              value={taskTime ?? new Date()}
              mode="time"
              display="spinner"
              onChange={(_e, d) => {
                if (d) setTaskTime(d)
              }}
            />
          ) : null}
          <Text style={styles.scheduleHint}>Status: {combineDateAndTime(taskDate, taskTime) ? 'Scheduled' : 'Unscheduled'}</Text>
          <View style={styles.formActions}>
            <Pressable
              style={[styles.actionButton, styles.cancelButton]}
              onPress={() => {
                resetForm()
              }}
            >
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.actionButton, styles.saveButton, (!taskTitle.trim() || saveLocalDraft.isPending) && styles.disabledButton]}
              onPress={() => saveLocalDraft.mutate()}
              disabled={!taskTitle.trim() || saveLocalDraft.isPending}
            >
              <Text style={styles.saveButtonText}>{saveLocalDraft.isPending ? 'Saving...' : 'Save locally'}</Text>
            </Pressable>
          </View>
        </View>
      )}
      <FlatList
        data={publishedTasks}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={query.isRefetching} onRefresh={() => query.refetch()} />}
        ListHeaderComponent={
          <View style={styles.listSections}>
            <SectionHeader title="Local Drafts" />
            {localDrafts.length === 0 ? (
              <Text style={styles.emptyLocalDrafts}>No unpublished task drafts on this phone.</Text>
            ) : (
              localDrafts.map((draft) => (
                <PressableCard key={draft.id} style={styles.card} onPress={() => loadDraftIntoForm(draft)}>
                  <View style={styles.row}>
                    <Text style={styles.cardTitle}>{draft.title || 'Untitled local task'}</Text>
                    <StatusBadge status={draft.publishState === 'publishFailed' ? 'FAILED' : 'LOCAL DRAFT'} />
                  </View>
                  <Text style={styles.meta}>
                    {draft.publishState === 'publishFailed'
                      ? 'Unpublished · Publish failed'
                      : draft.publishState === 'readyToPublish'
                        ? 'Local draft · Ready to publish'
                        : 'Local draft · Unpublished'}
                  </Text>
                  {draft.selectedClientName ? <Text style={styles.meta}>Client: {draft.selectedClientName}</Text> : null}
                  <Text style={styles.meta}>{formatScheduledAt(draft.scheduledAt)}</Text>
                  <Text style={styles.meta}>Status: {draft.scheduledAt ? 'Scheduled' : 'Unscheduled'}</Text>
                  {draft.publishError ? <Text style={styles.errorText}>{draft.publishError}</Text> : null}
                  <View style={styles.draftActionRow}>
                    <Pressable style={styles.mutedButton} onPress={() => loadDraftIntoForm(draft)}>
                      <Text style={styles.mutedButtonText}>Edit</Text>
                    </Pressable>
                    <Pressable
                      style={[styles.mutedButton, !isOnline && styles.disabledButton]}
                      onPress={() => publishTaskMutation.mutate(draft)}
                      disabled={!isOnline || publishTaskMutation.isPending}
                    >
                      <Text style={styles.mutedButtonText}>{publishTaskMutation.isPending ? 'Publishing...' : 'Publish'}</Text>
                    </Pressable>
                    <Pressable style={styles.mutedButton} onPress={() => void onConvertDraft(draft)}>
                      <Text style={styles.mutedButtonText}>Convert to request</Text>
                    </Pressable>
                    <Pressable style={styles.deleteButton} onPress={() => onDeleteDraft(draft)}>
                      <Text style={styles.deleteButtonText}>Delete</Text>
                    </Pressable>
                  </View>
                </PressableCard>
              ))
            )}
            <SectionHeader title={filterLabel} />
          </View>
        }
        ListEmptyComponent={
          <EmptyState
            icon="checkbox-outline"
            title={`No ${filterLabel.toLowerCase()}`}
            description="Nothing matches this filter right now."
          />
        }
        renderItem={({ item }) => (
          <PressableCard
            style={styles.card}
            onPress={() => navigation.navigate('TaskDetail', { taskId: item.id })}
          >
            <View style={styles.row}>
              <Text style={styles.cardTitle}>{item.title}</Text>
              <StatusBadge status={item.status} />
            </View>
            <Text style={styles.meta}>{item.description || 'No description'}</Text>
            <Text style={styles.meta}>Priority: {item.priority}</Text>
            {item.client?.name ? <Text style={styles.meta}>Client: {item.client.name}</Text> : null}
            <Text style={styles.meta}>{formatScheduledAt(item.dueDate)}</Text>
          </PressableCard>
        )}
      />
      <Modal
        visible={showClientPicker}
        transparent
        animationType="fade"
        onRequestClose={() => setShowClientPicker(false)}
      >
        <View style={styles.modalBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowClientPicker(false)} />
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Select Client</Text>
            <TextInput
              style={styles.input}
              placeholder="Search client"
              placeholderTextColor={colors.textPrimary}
              selectionColor={colors.textPrimary}
              cursorColor={colors.textPrimary}
              value={clientSearch}
              onChangeText={setClientSearch}
            />
            <ScrollView style={styles.clientList}>
              <Pressable
                style={styles.clientRow}
                onPress={() => {
                  setTaskClientId(null)
                  setTaskClientName(null)
                  setShowClientPicker(false)
                }}
              >
                <Text style={styles.clientRowName}>No client</Text>
                <Text style={styles.clientRowMeta}>Leave this task unattached</Text>
              </Pressable>
              {clientRows.map((client) => (
                <Pressable
                  key={client.id}
                  style={styles.clientRow}
                  onPress={() => {
                    setTaskClientId(client.id)
                    setTaskClientName(client.name)
                    setShowClientPicker(false)
                  }}
                >
                  <Text style={styles.clientRowName}>{client.name}</Text>
                  {!!client.companyName ? <Text style={styles.clientRowMeta}>{client.companyName}</Text> : null}
                </Pressable>
              ))}
              {clientsQuery.isLoading ? <Text style={styles.modalHint}>Loading clients...</Text> : null}
              {!clientsQuery.isLoading && clientRows.length === 0 ? (
                <Text style={styles.modalHint}>No clients found.</Text>
              ) : null}
            </ScrollView>
            <Pressable style={styles.modalCloseButton} onPress={() => setShowClientPicker(false)}>
              <Text style={styles.modalCloseText}>Close</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </AppScreen>
  )
}

const styles = StyleSheet.create({
  header: { paddingTop: spacing.sm, paddingBottom: spacing.sm },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  title: { ...typography.h2, color: colors.textPrimary },
  subtitle: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  filterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: spacing.sm,
  },
  filterChip: {
    borderWidth: 1,
    borderColor: '#D0D5DD',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: '#FFFFFF',
  },
  filterChipActive: {
    backgroundColor: colors.brandPrimary,
    borderColor: colors.brandPrimary,
  },
  filterChipText: {
    ...typography.caption,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  filterChipTextActive: {
    color: '#E6C98B',
  },
  createButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.brandPrimary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: { marginBottom: spacing.sm },
  cardTitle: { ...typography.sub, color: colors.textPrimary, fontWeight: '700', flex: 1, marginRight: 8 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  meta: { ...typography.caption, color: colors.textSecondary },
  formCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: spacing.sm,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: '#E4E7EC',
    gap: spacing.xs,
  },
  formTitle: {
    ...typography.sub,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  input: {
    borderWidth: 1,
    borderColor: '#D0D5DD',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.textPrimary,
    backgroundColor: '#FFFFFF',
  },
  clientSelectButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: '#D0D5DD',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#FFFFFF',
  },
  clientSelectValue: {
    ...typography.caption,
    color: colors.textPrimary,
    flex: 1,
    fontSize: 13,
  },
  clientSelectPlaceholder: {
    ...typography.caption,
    color: colors.textSecondary,
    flex: 1,
    fontSize: 13,
  },
  multilineInput: {
    minHeight: 88,
    textAlignVertical: 'top',
  },
  formActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.xs,
    marginTop: 4,
  },
  actionButton: {
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  cancelButton: {
    borderWidth: 1,
    borderColor: '#D0D5DD',
    backgroundColor: '#FFFFFF',
  },
  saveButton: {
    backgroundColor: colors.brandPrimary,
  },
  cancelButtonText: {
    ...typography.caption,
    color: colors.textSecondary,
    fontWeight: '700',
  },
  saveButtonText: {
    ...typography.caption,
    color: '#E6C98B',
    fontWeight: '700',
  },
  disabledButton: {
    opacity: 0.6,
  },
  datePickerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: '#D0D5DD',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#FAFAFA',
  },
  datePickerText: {
    ...typography.caption,
    color: colors.textSecondary,
    flex: 1,
    fontSize: 13,
  },
  scheduleHint: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  listSections: {
    gap: spacing.xs,
  },
  emptyLocalDrafts: {
    ...typography.caption,
    color: colors.textSecondary,
    marginBottom: spacing.sm,
  },
  draftActionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  mutedButton: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#D0D5DD',
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: '#FFFFFF',
  },
  mutedButtonText: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  deleteButton: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#FCA5A5',
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: '#FEF2F2',
  },
  deleteButtonText: {
    ...typography.caption,
    color: '#B42318',
    fontWeight: '700',
  },
  errorText: {
    ...typography.caption,
    color: '#B42318',
    marginTop: 4,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.35)',
    justifyContent: 'center',
    padding: spacing.md,
  },
  modalCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: spacing.md,
    maxHeight: '70%',
    gap: spacing.xs,
  },
  modalTitle: {
    ...typography.sub,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  clientList: {
    maxHeight: 280,
  },
  clientRow: {
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#EAECF0',
  },
  clientRowName: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  clientRowMeta: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: 2,
  },
  modalHint: {
    ...typography.caption,
    color: colors.textSecondary,
    paddingVertical: 12,
  },
  modalCloseButton: {
    alignSelf: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  modalCloseText: {
    ...typography.caption,
    color: colors.brandPrimary,
    fontWeight: '700',
  },
})

