import React, { useMemo, useState } from 'react'
import { Alert, FlatList, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker'
import { useQuery } from '@tanstack/react-query'
import { NativeStackScreenProps } from '@react-navigation/native-stack'
import { AppScreen } from '../../components/AppScreen'
import { apiRequest } from '../../api/client'
import { Issue } from '../../types/models'
import { IssuesStackParamList } from '../../types/navigation'
import { useMobilePermissions } from '../../hooks/useMobilePermissions'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Ionicons } from '@expo/vector-icons'
import { colors, spacing, typography } from '../../theme/tokens'
import { EmptyState } from '../../components/EmptyState'
import { PressableCard } from '../../components/Card'
import { StatusBadge } from '../../components/StatusBadge'
import { SectionHeader } from '../../components/SectionHeader'
import { combineDateAndTime, formatScheduledAt } from '../../utils/schedule'

interface IssuesResponse {
  issues: Issue[]
}

interface ClientListResponse {
  clients: Array<{
    id: string
    name: string
    companyName?: string | null
  }>
}

type Props = NativeStackScreenProps<IssuesStackParamList, 'IssuesList'>

export function IssuesScreen({ navigation }: Props) {
  const { canCreateIssues, canAssignIssuesToAdmin } = useMobilePermissions()
  const queryClient = useQueryClient()
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [issueTitle, setIssueTitle] = useState('')
  const [issueDescription, setIssueDescription] = useState('')
  const [issueNotes, setIssueNotes] = useState('')
  const [issueClientId, setIssueClientId] = useState<string | null>(null)
  const [issueClientName, setIssueClientName] = useState<string | null>(null)
  const [clientSearch, setClientSearch] = useState('')
  const [showClientPicker, setShowClientPicker] = useState(false)
  const [issueDate, setIssueDate] = useState<Date | null>(null)
  const [issueTime, setIssueTime] = useState<Date | null>(null)
  const [showDatePicker, setShowDatePicker] = useState(false)
  const [showTimePicker, setShowTimePicker] = useState(false)

  const query = useQuery({
    queryKey: ['mobile-issues'],
    queryFn: () => apiRequest<IssuesResponse>('/api/issues?filter=assigned_or_created&limit=100'),
    refetchInterval: 60_000,
  })

  const clientsQuery = useQuery({
    queryKey: ['mobile-issue-clients', clientSearch],
    queryFn: () =>
      apiRequest<ClientListResponse>(
        `/api/clients?status=active&limit=100&search=${encodeURIComponent(clientSearch.trim())}`
      ),
    enabled: showClientPicker,
  })

  const clientRows = useMemo(() => clientsQuery.data?.clients || [], [clientsQuery.data?.clients])

  const createIssueMutation = useMutation({
    mutationFn: async () => {
      // Get admin users for assignment
      const usersResponse = await apiRequest<{ users: Array<{ id: string; role: string; firstName: string; lastName: string }> }>(
        '/api/users?role=ADMIN&limit=10'
      )
      const adminUsers = usersResponse.users.filter((u) => u.role === 'ADMIN' || u.role === 'OFFICE')
      
      if (adminUsers.length === 0) {
        throw new Error('No admin users found to assign the issue to.')
      }

      const assigneeId = adminUsers[0].id
      const descriptionWithNotes = [issueDescription.trim(), issueNotes.trim() ? `Notes:\n${issueNotes.trim()}` : '']
        .filter(Boolean)
        .join('\n\n')
      
      return apiRequest('/api/issues?mobile=true', 'POST', {
        title: issueTitle.trim(),
        description: descriptionWithNotes || null,
        assigneeId,
        type: 'OTHER',
        priority: 'MEDIUM',
        status: 'OPEN',
        dueDate: combineDateAndTime(issueDate, issueTime),
        clientId: issueClientId || null,
      })
    },
    onSuccess: () => {
      setIssueClientId(null)
      setIssueClientName(null)
      setClientSearch('')
      setShowClientPicker(false)
      setIssueDate(null)
      setIssueTime(null)
      setShowDatePicker(false)
      setShowTimePicker(false)
      queryClient.invalidateQueries({ queryKey: ['mobile-issues'] })
      queryClient.invalidateQueries({ queryKey: ['mobile-assignments'] })
      setIssueTitle('')
      setIssueDescription('')
      setIssueNotes('')
      setShowCreateForm(false)
      Alert.alert('Success', 'Issue created and assigned to admin')
    },
    onError: (error: any) => {
      Alert.alert('Error', error?.message || 'Failed to create issue')
    },
  })

  return (
    <AppScreen>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.title}>Issues</Text>
            <Text style={styles.subtitle}>Track open field issues and resolve them quickly.</Text>
          </View>
          {canCreateIssues() && canAssignIssuesToAdmin() && (
            <Pressable
              style={styles.createButton}
              onPress={() => setShowCreateForm((prev) => !prev)}
              disabled={createIssueMutation.isPending}
            >
              <Ionicons name="add" size={24} color="#E6C98B" />
            </Pressable>
          )}
        </View>
      </View>
      {showCreateForm && (
        <View style={styles.formCard}>
          <Text style={styles.formTitle}>Create Issue</Text>
          <TextInput
            style={styles.input}
            placeholder="Title"
            placeholderTextColor={colors.textPrimary}
            selectionColor={colors.textPrimary}
            cursorColor={colors.textPrimary}
            value={issueTitle}
            onChangeText={setIssueTitle}
          />
          <TextInput
            style={[styles.input, styles.multilineInput]}
            placeholder="Description"
            placeholderTextColor={colors.textPrimary}
            selectionColor={colors.textPrimary}
            cursorColor={colors.textPrimary}
            value={issueDescription}
            onChangeText={setIssueDescription}
            multiline
          />
          <TextInput
            style={[styles.input, styles.multilineInput]}
            placeholder="Notes"
            placeholderTextColor={colors.textPrimary}
            selectionColor={colors.textPrimary}
            cursorColor={colors.textPrimary}
            value={issueNotes}
            onChangeText={setIssueNotes}
            multiline
          />
          <Pressable style={styles.clientSelectButton} onPress={() => setShowClientPicker(true)}>
            <Ionicons name="people-outline" size={16} color={colors.textSecondary} />
            <Text style={issueClientName ? styles.clientSelectValue : styles.clientSelectPlaceholder}>
              {issueClientName || 'Client · Optional'}
            </Text>
            {issueClientId ? (
              <Pressable
                onPress={() => {
                  setIssueClientId(null)
                  setIssueClientName(null)
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
                  value: issueDate ?? new Date(),
                  mode: 'date',
                  onChange: (_e, d) => {
                    if (d) setIssueDate(d)
                  },
                })
              } else {
                setShowDatePicker(!showDatePicker)
              }
            }}
          >
            <Ionicons name="calendar-outline" size={16} color={colors.textSecondary} />
            <Text style={styles.datePickerText}>
              {issueDate
                ? issueDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                : 'Date · Optional / Unscheduled'}
            </Text>
            {issueDate ? (
              <Pressable onPress={() => setIssueDate(null)} hitSlop={8}>
                <Ionicons name="close-circle" size={16} color={colors.textSecondary} />
              </Pressable>
            ) : null}
          </Pressable>
          {Platform.OS === 'ios' && showDatePicker ? (
            <DateTimePicker
              value={issueDate ?? new Date()}
              mode="date"
              display="spinner"
              onChange={(_e, d) => {
                if (d) setIssueDate(d)
              }}
            />
          ) : null}
          <Pressable
            style={styles.datePickerButton}
            onPress={() => {
              if (Platform.OS === 'android') {
                DateTimePickerAndroid.open({
                  value: issueTime ?? new Date(),
                  mode: 'time',
                  onChange: (_e, d) => {
                    if (d) setIssueTime(d)
                  },
                })
              } else {
                setShowTimePicker(!showTimePicker)
              }
            }}
          >
            <Ionicons name="time-outline" size={16} color={colors.textSecondary} />
            <Text style={styles.datePickerText}>
              {issueTime
                ? issueTime.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
                : 'Time · Optional / Unscheduled'}
            </Text>
            {issueTime ? (
              <Pressable onPress={() => setIssueTime(null)} hitSlop={8}>
                <Ionicons name="close-circle" size={16} color={colors.textSecondary} />
              </Pressable>
            ) : null}
          </Pressable>
          {Platform.OS === 'ios' && showTimePicker ? (
            <DateTimePicker
              value={issueTime ?? new Date()}
              mode="time"
              display="spinner"
              onChange={(_e, d) => {
                if (d) setIssueTime(d)
              }}
            />
          ) : null}
          <Text style={styles.scheduleHint}>Status: {combineDateAndTime(issueDate, issueTime) ? 'Scheduled' : 'Unscheduled'}</Text>
          <View style={styles.formActions}>
            <Pressable
              style={[styles.actionButton, styles.cancelButton]}
              onPress={() => {
                setShowCreateForm(false)
                setIssueTitle('')
                setIssueDescription('')
                setIssueNotes('')
                setIssueClientId(null)
                setIssueClientName(null)
                setClientSearch('')
                setShowClientPicker(false)
                setIssueDate(null)
                setIssueTime(null)
              }}
            >
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.actionButton, styles.saveButton, (!issueTitle.trim() || createIssueMutation.isPending) && styles.disabledButton]}
              onPress={() => createIssueMutation.mutate()}
              disabled={!issueTitle.trim() || createIssueMutation.isPending}
            >
              <Text style={styles.saveButtonText}>{createIssueMutation.isPending ? 'Saving...' : 'Create'}</Text>
            </Pressable>
          </View>
        </View>
      )}
      <FlatList
        data={query.data?.issues ?? []}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={query.isRefetching} onRefresh={() => query.refetch()} />}
        ListHeaderComponent={<SectionHeader title="Active Issues" />}
        ListEmptyComponent={<EmptyState icon="alert-circle-outline" title="No issues yet" description="Assigned and created issues will appear here." />}
        renderItem={({ item }) => (
          <PressableCard
            style={styles.card}
            onPress={() => navigation.navigate('IssueDetail', { issueId: item.id })}
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
                  setIssueClientId(null)
                  setIssueClientName(null)
                  setShowClientPicker(false)
                }}
              >
                <Text style={styles.clientRowName}>No client</Text>
                <Text style={styles.clientRowMeta}>Leave this issue unattached</Text>
              </Pressable>
              {clientRows.map((client) => (
                <Pressable
                  key={client.id}
                  style={styles.clientRow}
                  onPress={() => {
                    setIssueClientId(client.id)
                    setIssueClientName(client.name)
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

