import React from 'react'
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Linking,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useFocusEffect } from '@react-navigation/native'
import { NativeStackScreenProps } from '@react-navigation/native-stack'
import { InfiniteData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Ionicons } from '@expo/vector-icons'
import { AppScreen } from '../../components/AppScreen'
import { EmptyState } from '../../components/EmptyState'
import { DetailRow, DetailSection } from '../../components/DetailSection'
import { apiRequest } from '../../api/client'
import { JobsStackParamList } from '../../types/navigation'
import { colors, radius, spacing, typography } from '../../theme/tokens'
import { getRequestDetailsErrorCopy } from './request-utils'
import { AttachmentPickerSheet } from '../../components/attachments/AttachmentPickerSheet'
import { AttachmentUploadQueue } from '../../components/attachments/AttachmentUploadQueue'
import { pickAttachmentsByAction, uploadFileWithProgress } from '../../services/attachment-upload'
import { isPdfAttachment, normalizeAttachmentUrl } from '../../services/open-attachment'
import { AttachmentGalleryModal } from '../../components/attachments/AttachmentGalleryModal'
import { AttachmentOpenPressable } from '../../components/attachments/AttachmentOpenPressable'
import { useAttachmentUploadQueue } from '../../hooks/useAttachmentUploadQueue'
import { useMobilePermissions } from '../../hooks/useMobilePermissions'

type Props = NativeStackScreenProps<JobsStackParamList, 'RequestDetail'>

interface RequestPerson {
  id?: string
  firstName?: string | null
  lastName?: string | null
  email?: string | null
  phone?: string | null
}

interface RequestDetailLead {
  id: string
  firstName: string
  lastName: string
  email?: string | null
  phone?: string | null
  company?: string | null
  source: string
  status: string
  jobType?: string | null
  isUrgent?: boolean
  urgentAt?: string | null
  urgentByUserId?: string | null
  value?: string | number | null
  probability?: number | null
  notes?: string | null
  jobSiteAddress?: string | null
  jobSiteCity?: string | null
  jobSiteState?: string | null
  jobSiteZipCode?: string | null
  convertedToClientId?: string | null
  convertedAt?: string | null
  createdAt: string
  assignedTo?: RequestPerson | null
  client?: {
    id: string
    name: string
    companyName?: string | null
  } | null
  estimates?: Array<{
    id: string
    estimateNumber: string
    title: string
    total: string | number
    status: string
    createdAt: string
  }>
  tasks?: Array<{
    id: string
    title: string
    status: string
    priority?: string
    dueDate?: string | null
  }>
  issues?: Array<{
    id: string
    title: string
    status: string
    priority?: string
  }>
  calls?: Array<{
    id: string
    direction: string
    status: string
    fromNumber: string
    toNumber: string
    duration?: number | null
    startedAt: string
  }>
  smsMessages?: Array<{
    id: string
    direction: string
    status: string
    body?: string | null
    sentAt?: string | null
  }>
  emails?: Array<{
    id: string
    direction: string
    status: string
    subject: string
    sentAt?: string | null
  }>
  schedules?: Array<{
    id: string
    startTime: string
    endTime: string
    user?: {
      firstName?: string | null
      lastName?: string | null
    } | null
  }>
  activities?: Array<{
    id: string
    type: string
    description: string
    createdAt: string
    user?: {
      firstName?: string | null
      lastName?: string | null
    } | null
  }>
  _count?: {
    estimates?: number
    tasks?: number
    issues?: number
    calls?: number
    smsMessages?: number
    emails?: number
  }
}

interface RequestDetailResponse {
  lead: RequestDetailLead
}

interface AttachmentResponse {
  attachments: Array<{
    id: string
    fileName: string
    url: string
    mimeType: string
    fileSize: number
    createdAt: string
    thumbnailUrl?: string | null
    previewUrl?: string | null
  }>
}

interface TeamMember {
  id: string
  firstName: string
  lastName: string
  email?: string | null
  role?: string
}

const STATUS_LABELS: Record<string, string> = {
  NEW: 'New',
  CONTACTED: 'Contacted',
  QUALIFIED: 'Qualified',
  ESTIMATE_CREATED: 'Estimate Created',
  ESTIMATE_SENT: 'Estimate Sent',
  FOLLOW_UP: 'Follow Up',
  CONVERTED: 'Converted',
  LOST: 'Lost',
}

function formatLabel(value?: string | null) {
  if (!value) return ''
  return STATUS_LABELS[value] || value.replace(/_/g, ' ')
}

function formatCurrency(value?: string | number | null) {
  if (value === null || value === undefined || value === '') return null
  const amount = typeof value === 'number' ? value : Number.parseFloat(String(value))
  if (!Number.isFinite(amount)) return String(value)
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount)
}

function formatDate(value?: string | null) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleString()
}

function formatDuration(seconds?: number | null) {
  if (seconds === null || seconds === undefined) return 'N/A'
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

function personName(person?: RequestPerson | null) {
  if (!person) return 'Unassigned'
  return `${person.firstName || ''} ${person.lastName || ''}`.trim() || 'Unassigned'
}

function ActionChip({
  label,
  icon,
  onPress,
  active,
}: {
  label: string
  icon: keyof typeof Ionicons.glyphMap
  onPress: () => void
  active?: boolean
}) {
  return (
    <Pressable style={[styles.actionChip, active && styles.actionChipActive]} onPress={onPress}>
      <Ionicons name={icon} size={16} color={active ? '#B91C1C' : colors.brandPrimary} />
      <Text style={[styles.actionChipText, active && styles.actionChipTextActive]}>{label}</Text>
    </Pressable>
  )
}

function TimelineItem({
  icon,
  title,
  subtitle,
  meta,
  badge,
}: {
  icon: keyof typeof Ionicons.glyphMap
  title: string
  subtitle?: string | null
  meta?: string | null
  badge?: string | null
}) {
  return (
    <View style={styles.timelineItem}>
      <Ionicons name={icon} size={18} color={colors.brandPrimary} style={styles.timelineIcon} />
      <View style={styles.timelineBody}>
        <View style={styles.timelineTitleRow}>
          <Text style={styles.timelineTitle}>{title}</Text>
          {badge ? <Text style={styles.timelineBadge}>{badge}</Text> : null}
        </View>
        {subtitle ? <Text style={styles.timelineSubtitle}>{subtitle}</Text> : null}
        {meta ? <Text style={styles.timelineMeta}>{meta}</Text> : null}
      </View>
    </View>
  )
}

export function RequestDetailScreen({ route }: Props) {
  const { requestId } = route.params
  const queryClient = useQueryClient()
  const permissions = useMobilePermissions()
  const allowViewRequests = permissions.canViewRequests()
  const allowEditRequests = permissions.canEditRequests()
  const allowAssignRequests = permissions.canAssignRequests()
  const allowViewFinancials = permissions.canViewRequestFinancials()
  const allowViewEstimates = permissions.canViewRequestEstimates()
  const allowViewCommunication = permissions.canViewRequestCommunication()
  const allowViewActivity = permissions.canViewRequestActivity()
  const allowViewTasksIssues = permissions.canViewRequestTasksIssues()
  const allowViewConvertedClient = permissions.canViewRequestConvertedClient()

  const [isPullRefreshing, setIsPullRefreshing] = React.useState(false)
  const [showAttachmentPicker, setShowAttachmentPicker] = React.useState(false)
  const [showAssignPicker, setShowAssignPicker] = React.useState(false)
  const [localAttachments, setLocalAttachments] = React.useState<AttachmentResponse['attachments']>([])
  const [galleryVisible, setGalleryVisible] = React.useState(false)
  const [galleryIndex, setGalleryIndex] = React.useState(0)

  const detailQuery = useQuery({
    queryKey: ['mobile-request-detail', requestId],
    queryFn: () => apiRequest<RequestDetailResponse>(`/api/leads/${requestId}`),
    refetchInterval: 8000,
    refetchOnWindowFocus: true,
    enabled: allowViewRequests,
  })

  const attachmentsQuery = useQuery({
    queryKey: ['mobile-request-attachments', requestId],
    queryFn: () =>
      apiRequest<AttachmentResponse>(
        `/api/attachments?entityType=request&entityId=${encodeURIComponent(requestId)}`
      ),
    enabled: allowViewRequests,
  })

  const teamQuery = useQuery({
    queryKey: ['mobile-request-assignable-team'],
    queryFn: () =>
      apiRequest<{ teamMembers?: TeamMember[]; users?: TeamMember[] }>('/api/schedules/team'),
    enabled: showAssignPicker && allowAssignRequests,
  })

  const urgentMutation = useMutation({
    mutationFn: (isUrgent: boolean) =>
      apiRequest<{ lead: Partial<RequestDetailLead> & { id: string; isUrgent?: boolean } }>(
        `/api/requests/${requestId}/urgent`,
        'PATCH',
        { isUrgent }
      ),
    onMutate: async (nextUrgent) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: ['mobile-request-detail', requestId] }),
        queryClient.cancelQueries({ queryKey: ['mobile-requests-list'] }),
      ])
      const previousDetail = queryClient.getQueryData<RequestDetailResponse>(['mobile-request-detail', requestId])
      const previousList = queryClient.getQueryData<InfiniteData<{ leads: Array<{ id: string; isUrgent?: boolean }> }>>([
        'mobile-requests-list',
      ])

      queryClient.setQueryData<RequestDetailResponse>(['mobile-request-detail', requestId], (existing) =>
        existing?.lead ? { ...existing, lead: { ...existing.lead, isUrgent: nextUrgent } } : existing
      )
      queryClient.setQueryData<InfiniteData<{ leads: Array<{ id: string; isUrgent?: boolean }> }>>(
        ['mobile-requests-list'],
        (existing) => {
          if (!existing) return existing
          return {
            ...existing,
            pages: existing.pages.map((page) => ({
              ...page,
              leads: (page.leads || []).map((lead) => (lead.id === requestId ? { ...lead, isUrgent: nextUrgent } : lead)),
            })),
          }
        }
      )

      return { previousDetail, previousList }
    },
    onError: (error: any, _nextUrgent, context) => {
      if (context?.previousDetail) {
        queryClient.setQueryData(['mobile-request-detail', requestId], context.previousDetail)
      }
      if (context?.previousList) {
        queryClient.setQueryData(['mobile-requests-list'], context.previousList)
      }
      Alert.alert('Failed', error?.message || 'Unable to update urgent flag.')
    },
    onSuccess: (payload) => {
      if (!payload?.lead) return
      queryClient.setQueryData<RequestDetailResponse>(['mobile-request-detail', requestId], (existing) => {
        if (!existing?.lead) return existing
        return {
          ...existing,
          lead: {
            ...existing.lead,
            isUrgent: payload.lead.isUrgent,
            urgentAt: payload.lead.urgentAt ?? existing.lead.urgentAt,
            urgentByUserId: payload.lead.urgentByUserId ?? existing.lead.urgentByUserId,
          },
        }
      })
      queryClient.setQueryData<InfiniteData<{ leads: Array<{ id: string; isUrgent?: boolean }> }>>(
        ['mobile-requests-list'],
        (existing) => {
          if (!existing) return existing
          return {
            ...existing,
            pages: existing.pages.map((page) => ({
              ...page,
              leads: (page.leads || []).map((lead) =>
                lead.id === requestId ? { ...lead, isUrgent: payload.lead.isUrgent } : lead
              ),
            })),
          }
        }
      )
    },
  })

  const assignMutation = useMutation({
    mutationFn: (assignedToId: string) =>
      apiRequest<{ lead: { assignedTo?: RequestPerson | null } }>(`/api/leads/${requestId}`, 'PUT', {
        assignedToId,
      }),
    onSuccess: (payload) => {
      queryClient.setQueryData<RequestDetailResponse>(['mobile-request-detail', requestId], (existing) => {
        if (!existing?.lead) return existing
        return {
          ...existing,
          lead: {
            ...existing.lead,
            assignedTo: payload?.lead?.assignedTo ?? existing.lead.assignedTo,
          },
        }
      })
      void detailQuery.refetch()
      Alert.alert('Assigned', 'Request assignee updated.')
    },
    onError: (error: any) => {
      Alert.alert('Assignment failed', error?.message || 'Unable to assign this request.')
    },
  })

  const requestUploadQueue = useAttachmentUploadQueue<{ attachment: AttachmentResponse['attachments'][number] }>({
    startUpload: (file, onProgress) => {
      const task = uploadFileWithProgress<{ attachment: AttachmentResponse['attachments'][number] }>(
        `/api/requests/${requestId}/attachments`,
        file,
        onProgress
      )
      return {
        promise: task.promise.then((result) => result.raw),
        cancel: task.cancel,
      }
    },
    onUploaded: (result) => {
      if (!result.attachment) return
      setLocalAttachments((prev) => [result.attachment, ...prev.filter((item) => item.id !== result.attachment.id)])
      void attachmentsQuery.refetch()
    },
  })

  useFocusEffect(
    React.useCallback(() => {
      if (!allowViewRequests) return () => {}
      void detailQuery.refetch()
      void attachmentsQuery.refetch()
      return () => {}
    }, [allowViewRequests, detailQuery.refetch, attachmentsQuery.refetch])
  )

  const handlePullRefresh = React.useCallback(async () => {
    setIsPullRefreshing(true)
    try {
      await Promise.all([detailQuery.refetch(), attachmentsQuery.refetch()])
    } finally {
      setIsPullRefreshing(false)
    }
  }, [detailQuery.refetch, attachmentsQuery.refetch])

  if (!allowViewRequests) {
    return (
      <AppScreen>
        <View style={styles.loadingWrap}>
          <EmptyState
            icon="lock-closed-outline"
            title="Access restricted"
            description="You don't have permission to view requests."
          />
        </View>
      </AppScreen>
    )
  }

  if (detailQuery.isLoading) {
    return (
      <AppScreen>
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={colors.brandPrimary} />
          <Text style={styles.loadingText}>Loading request...</Text>
        </View>
      </AppScreen>
    )
  }

  if (detailQuery.isError || !detailQuery.data?.lead) {
    const errorCopy = getRequestDetailsErrorCopy((detailQuery.error as Error | undefined)?.message)
    return (
      <AppScreen>
        <View style={styles.loadingWrap}>
          <EmptyState
            icon="document-text-outline"
            title={errorCopy.title}
            description={errorCopy.description}
          />
          {errorCopy.canRetry ? (
            <Pressable style={styles.retryButton} onPress={() => void detailQuery.refetch()}>
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          ) : null}
        </View>
      </AppScreen>
    )
  }

  const lead = detailQuery.data.lead
  const estimates = lead.estimates || []
  const calls = lead.calls || []
  const smsMessages = lead.smsMessages || []
  const emails = lead.emails || []
  const activities = lead.activities || []
  const tasks = lead.tasks || []
  const issues = lead.issues || []
  const count = lead._count || {}
  const valueNumber =
    lead.value === null || lead.value === undefined || lead.value === ''
      ? null
      : typeof lead.value === 'number'
        ? lead.value
        : Number.parseFloat(String(lead.value))
  const probability = lead.probability ?? null
  const expectedValue =
    valueNumber !== null && probability !== null && Number.isFinite(valueNumber)
      ? valueNumber * (probability / 100)
      : null
  const attachments = [...localAttachments, ...(attachmentsQuery.data?.attachments || [])].filter(
    (item, index, arr) => arr.findIndex((inner) => inner.id === item.id) === index
  )
  const teamMembers = teamQuery.data?.teamMembers || teamQuery.data?.users || []

  const onSelectAttachmentAction = async (
    action: 'take-photo' | 'record-video' | 'choose-photos' | 'choose-videos' | 'choose-audio' | 'choose-document'
  ) => {
    try {
      const picked = await pickAttachmentsByAction(action)
      if (!picked.length) return
      requestUploadQueue.enqueueFiles(picked)
    } catch (error: any) {
      Alert.alert('Attachment selection failed', error?.message || 'Please try again.')
    }
  }

  const openPhone = () => {
    if (!lead.phone) return
    void Linking.openURL(`tel:${lead.phone}`)
  }

  const openEmail = () => {
    if (!lead.email) return
    void Linking.openURL(`mailto:${lead.email}`)
  }

  return (
    <AppScreen>
      <FlatList
        data={attachments}
        keyExtractor={(item) => item.id}
        numColumns={2}
        columnWrapperStyle={styles.attachmentRow}
        refreshControl={
          <RefreshControl refreshing={isPullRefreshing} onRefresh={() => void handlePullRefresh()} />
        }
        contentContainerStyle={styles.content}
        ListHeaderComponent={
          <View>
            <DetailSection title="Request">
              <Text style={styles.name}>
                {lead.firstName} {lead.lastName}
              </Text>
              <View style={styles.badgeRow}>
                {lead.isUrgent ? <Text style={styles.urgentBadge}>URGENT</Text> : null}
                <Text style={styles.statusBadge}>{formatLabel(lead.status)}</Text>
                {lead.jobType ? <Text style={styles.metaBadge}>{formatLabel(lead.jobType)}</Text> : null}
                <Text style={styles.metaBadge}>{formatLabel(lead.source)}</Text>
              </View>
              {lead.company ? <Text style={styles.companyText}>{lead.company}</Text> : null}
              <DetailRow label="Created" value={formatDate(lead.createdAt)} />
              <DetailRow label="Request ID" value={lead.id} />
            </DetailSection>

            <DetailSection title="Quick Actions">
              <View style={styles.actionsRow}>
                {lead.phone ? <ActionChip label="Call" icon="call-outline" onPress={openPhone} /> : null}
                {lead.email ? <ActionChip label="Email" icon="mail-outline" onPress={openEmail} /> : null}
                {allowEditRequests ? (
                  <ActionChip
                    label={lead.isUrgent ? 'Unmark Urgent' : 'Mark Urgent'}
                    icon="alert-circle-outline"
                    active={!!lead.isUrgent}
                    onPress={() => urgentMutation.mutate(!lead.isUrgent)}
                  />
                ) : null}
                <ActionChip label="Add Attachment" icon="attach-outline" onPress={() => setShowAttachmentPicker(true)} />
              </View>
              <AttachmentUploadQueue
                items={requestUploadQueue.items}
                onRetry={(item) => requestUploadQueue.retryItem(item.id)}
                onRemove={(item) => requestUploadQueue.removeItem(item.id)}
                onCancel={(item) => requestUploadQueue.cancelItem(item.id)}
              />
            </DetailSection>

            <DetailSection title="Contact Information">
              <DetailRow label="Phone" value={lead.phone} />
              <DetailRow label="Email" value={lead.email} />
              <DetailRow label="Company" value={lead.company} />
              {!lead.phone && !lead.email && !lead.company ? (
                <Text style={styles.emptyText}>No contact details</Text>
              ) : null}
            </DetailSection>

            {lead.jobSiteAddress ? (
              <DetailSection title="Job Site">
                <DetailRow label="Address" value={lead.jobSiteAddress} multiline />
                <DetailRow label="City" value={lead.jobSiteCity || '-'} />
                <DetailRow label="State" value={lead.jobSiteState || '-'} />
                <DetailRow label="Zip Code" value={lead.jobSiteZipCode || '-'} />
              </DetailSection>
            ) : null}

            {allowViewFinancials && (lead.value || probability !== null) ? (
              <DetailSection title="Financial Information">
                <DetailRow label="Estimated Value" value={formatCurrency(lead.value)} />
                <DetailRow label="Probability" value={probability !== null ? `${probability}%` : null} />
                <DetailRow label="Expected Value" value={formatCurrency(expectedValue)} />
              </DetailSection>
            ) : null}

            {lead.notes ? (
              <DetailSection title="Notes">
                <Text style={styles.notesText}>{lead.notes}</Text>
              </DetailSection>
            ) : null}

            {allowViewEstimates ? (
              <DetailSection title={`Estimates (${count.estimates ?? estimates.length})`}>
                {estimates.length === 0 ? (
                  <Text style={styles.emptyText}>No estimates</Text>
                ) : (
                  estimates.map((estimate) => (
                    <View key={estimate.id} style={styles.listCard}>
                      <View style={styles.listCardMain}>
                        <Text style={styles.listCardTitle}>{estimate.estimateNumber}</Text>
                        <Text style={styles.listCardSubtitle}>{estimate.title}</Text>
                      </View>
                      <View style={styles.listCardSide}>
                        <Text style={styles.listCardAmount}>{formatCurrency(estimate.total)}</Text>
                        <Text style={styles.metaBadge}>{formatLabel(estimate.status)}</Text>
                      </View>
                    </View>
                  ))
                )}
              </DetailSection>
            ) : null}

            {allowViewCommunication ? (
              <DetailSection title="Communication Timeline">
                {calls.slice(0, 5).map((call) => (
                  <TimelineItem
                    key={call.id}
                    icon="call-outline"
                    title={`${call.direction === 'INBOUND' ? 'Inbound' : 'Outbound'} Call`}
                    subtitle={`${call.fromNumber} → ${call.toNumber}`}
                    meta={`${formatDate(call.startedAt) || ''} • ${formatDuration(call.duration)}`}
                    badge={call.status}
                  />
                ))}
                {smsMessages.slice(0, 5).map((sms) => (
                  <TimelineItem
                    key={sms.id}
                    icon="chatbubble-outline"
                    title={`${sms.direction === 'INBOUND' ? 'Inbound' : 'Outbound'} SMS`}
                    subtitle={
                      sms.body
                        ? sms.body.length > 100
                          ? `${sms.body.slice(0, 100)}...`
                          : sms.body
                        : 'No content'
                    }
                    meta={sms.sentAt ? formatDate(sms.sentAt) : 'Pending'}
                  />
                ))}
                {emails.slice(0, 5).map((email) => (
                  <TimelineItem
                    key={email.id}
                    icon="mail-outline"
                    title={email.subject || 'Email'}
                    subtitle={email.direction === 'INBOUND' ? 'Received' : 'Sent'}
                    meta={email.sentAt ? formatDate(email.sentAt) : 'Draft'}
                    badge={email.status}
                  />
                ))}
                {calls.length === 0 && smsMessages.length === 0 && emails.length === 0 ? (
                  <Text style={styles.emptyText}>No communication history</Text>
                ) : null}
              </DetailSection>
            ) : null}

            {allowViewActivity && activities.length > 0 ? (
              <DetailSection title="Activity Timeline">
                {activities.map((activity) => (
                  <View key={activity.id} style={styles.activityItem}>
                    <Text style={styles.timelineSubtitle}>{activity.description}</Text>
                    <Text style={styles.timelineMeta}>
                      {activity.user
                        ? `${activity.user.firstName || ''} ${activity.user.lastName || ''}`.trim() || 'System'
                        : 'System'}
                      {' • '}
                      {formatDate(activity.createdAt)}
                    </Text>
                  </View>
                ))}
              </DetailSection>
            ) : null}

            <DetailSection title="Statistics">
              <View style={styles.statsGrid}>
                <View style={styles.statCell}>
                  <Text style={styles.statValue}>{count.estimates ?? 0}</Text>
                  <Text style={styles.statLabel}>Estimates</Text>
                </View>
                <View style={styles.statCell}>
                  <Text style={styles.statValue}>{count.tasks ?? 0}</Text>
                  <Text style={styles.statLabel}>Tasks</Text>
                </View>
                <View style={styles.statCell}>
                  <Text style={styles.statValue}>{count.calls ?? 0}</Text>
                  <Text style={styles.statLabel}>Calls</Text>
                </View>
                <View style={styles.statCell}>
                  <Text style={styles.statValue}>{count.smsMessages ?? 0}</Text>
                  <Text style={styles.statLabel}>Messages</Text>
                </View>
              </View>
            </DetailSection>

            <DetailSection
              title="Assigned To"
              right={
                allowAssignRequests ? (
                  <Pressable style={styles.assignButton} onPress={() => setShowAssignPicker(true)}>
                    <Ionicons name="person-add-outline" size={16} color={colors.brandPrimary} />
                    <Text style={styles.assignButtonText}>Assign</Text>
                  </Pressable>
                ) : undefined
              }
            >
              {lead.assignedTo ? (
                <>
                  <DetailRow label="Name" value={personName(lead.assignedTo)} />
                  <DetailRow label="Email" value={lead.assignedTo.email} />
                  <DetailRow label="Phone" value={lead.assignedTo.phone} />
                </>
              ) : (
                <Text style={styles.emptyText}>Unassigned</Text>
              )}
            </DetailSection>

            {allowViewConvertedClient && lead.convertedToClientId && lead.client ? (
              <DetailSection title="Converted Client">
                <DetailRow label="Client" value={lead.client.name} />
                <DetailRow label="Company" value={lead.client.companyName} />
                <DetailRow label="Converted" value={formatDate(lead.convertedAt)} />
              </DetailSection>
            ) : null}

            {allowViewTasksIssues ? (
              <>
                <DetailSection title={`Tasks (${count.tasks ?? tasks.length})`}>
                  {tasks.length === 0 ? (
                    <Text style={styles.emptyText}>No tasks</Text>
                  ) : (
                    tasks.map((task) => (
                      <View key={task.id} style={styles.listCard}>
                        <View style={styles.listCardMain}>
                          <Text style={styles.listCardTitle}>{task.title}</Text>
                          <Text style={styles.listCardSubtitle}>
                            {formatLabel(task.status)}
                            {task.dueDate ? ` • Due ${formatDate(task.dueDate)}` : ''}
                          </Text>
                        </View>
                        {task.priority ? <Text style={styles.metaBadge}>{formatLabel(task.priority)}</Text> : null}
                      </View>
                    ))
                  )}
                </DetailSection>

                <DetailSection title={`Issues (${count.issues ?? issues.length})`}>
                  {issues.length === 0 ? (
                    <Text style={styles.emptyText}>No issues</Text>
                  ) : (
                    issues.map((issue) => (
                      <View key={issue.id} style={styles.listCard}>
                        <View style={styles.listCardMain}>
                          <Text style={styles.listCardTitle}>{issue.title}</Text>
                          <Text style={styles.listCardSubtitle}>{formatLabel(issue.status)}</Text>
                        </View>
                        {issue.priority ? <Text style={styles.metaBadge}>{formatLabel(issue.priority)}</Text> : null}
                      </View>
                    ))
                  )}
                </DetailSection>
              </>
            ) : null}

            <Text style={styles.sectionTitle}>Attachments ({attachments.length})</Text>
          </View>
        }
        ListEmptyComponent={<Text style={styles.emptyAttachments}>No attachments.</Text>}
        renderItem={({ item }) => {
          const idx = attachments.findIndex((row) => row.id === item.id)
          return (
          <AttachmentOpenPressable
            attachment={item}
            style={styles.attachmentCard}
            onOpenGallery={() => {
              setGalleryIndex(Math.max(0, idx))
              setGalleryVisible(true)
            }}
          >
            {String(item.mimeType || '').toLowerCase().startsWith('image/') ? (
              <Image source={{ uri: item.url }} style={styles.attachmentImage} resizeMode="cover" />
            ) : isPdfAttachment(item.mimeType, item.fileName) &&
              String(item.thumbnailUrl || item.previewUrl || '').trim() ? (
              <Image
                source={{ uri: String(item.thumbnailUrl || item.previewUrl) }}
                style={styles.attachmentImage}
                resizeMode="cover"
              />
            ) : (
              <View style={styles.attachmentIconWrap}>
                <Ionicons
                  name={
                    String(item.mimeType || '').toLowerCase().startsWith('video/')
                      ? 'videocam-outline'
                      : isPdfAttachment(item.mimeType, item.fileName)
                        ? 'document-outline'
                        : 'document-text-outline'
                  }
                  size={22}
                  color={colors.textSecondary}
                />
                {!String(item.mimeType || '').toLowerCase().startsWith('video/') ? (
                  <Text style={styles.attachmentFileBadge}>
                    {isPdfAttachment(item.mimeType, item.fileName) ? 'PDF FILE' : 'FILE'}
                  </Text>
                ) : null}
              </View>
            )}
          </AttachmentOpenPressable>
          )
        }}
      />

      <AttachmentGalleryModal
        visible={galleryVisible}
        attachments={attachments.map((row) => ({
          id: row.id,
          fileName: row.fileName || 'Attachment',
          fileSize: row.fileSize,
          mimeType: row.mimeType || 'application/octet-stream',
          url: normalizeAttachmentUrl(row.url) || row.url,
        }))}
        index={galleryIndex}
        onClose={() => setGalleryVisible(false)}
        onIndexChange={setGalleryIndex}
        entityType="request"
        entityId={requestId}
        onAttachmentCreated={() => {
          queryClient.invalidateQueries({ queryKey: ['mobile-request-attachments', requestId] })
        }}
      />

      <Modal visible={showAssignPicker} transparent animationType="fade" onRequestClose={() => setShowAssignPicker(false)}>
        <View style={styles.modalBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowAssignPicker(false)} />
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Assign Request</Text>
            <ScrollView style={styles.modalScroll}>
              {teamQuery.isLoading ? <Text style={styles.emptyText}>Loading team...</Text> : null}
              {!teamQuery.isLoading && teamMembers.length === 0 ? (
                <Text style={styles.emptyText}>No team members available.</Text>
              ) : null}
              {teamMembers.map((member) => {
                const active = lead.assignedTo?.id === member.id
                return (
                  <Pressable
                    key={member.id}
                    style={[styles.modalRow, active && styles.modalRowActive]}
                    disabled={assignMutation.isPending || active}
                    onPress={() => {
                      setShowAssignPicker(false)
                      assignMutation.mutate(member.id)
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.modalRowTitle}>
                        {member.firstName} {member.lastName}
                      </Text>
                      <Text style={styles.modalRowMeta}>
                        {[member.role, member.email].filter(Boolean).join(' • ')}
                      </Text>
                    </View>
                    {active ? (
                      <Ionicons name="checkmark" size={18} color={colors.brandPrimary} />
                    ) : (
                      <Ionicons name="person-add-outline" size={18} color={colors.brandPrimary} />
                    )}
                  </Pressable>
                )
              })}
            </ScrollView>
            <Pressable style={styles.modalCloseButton} onPress={() => setShowAssignPicker(false)}>
              <Text style={styles.modalCloseText}>Close</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <AttachmentPickerSheet
        visible={showAttachmentPicker}
        onClose={() => setShowAttachmentPicker(false)}
        onSelect={onSelectAttachmentAction}
      />
    </AppScreen>
  )
}

const styles = StyleSheet.create({
  loadingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
  },
  loadingText: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  retryButton: {
    marginTop: spacing.sm,
    backgroundColor: colors.brandPrimary,
    borderRadius: 10,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  retryText: {
    ...typography.sub,
    color: colors.surface,
    fontWeight: '600',
  },
  content: {
    paddingBottom: spacing.xl,
    paddingHorizontal: spacing.md,
  },
  name: {
    ...typography.h3,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  companyText: {
    ...typography.sub,
    color: colors.textSecondary,
  },
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  urgentBadge: {
    ...typography.caption,
    color: '#B91C1C',
    backgroundColor: '#FEE2E2',
    borderWidth: 1,
    borderColor: '#FCA5A5',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    fontWeight: '700',
  },
  statusBadge: {
    ...typography.caption,
    color: colors.brandPrimary,
    backgroundColor: '#E8EEF1',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    fontWeight: '700',
  },
  metaBadge: {
    ...typography.caption,
    color: colors.textSecondary,
    backgroundColor: '#F1F5F9',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    fontWeight: '600',
  },
  actionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  actionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    backgroundColor: colors.surface,
  },
  actionChipActive: {
    borderColor: '#FCA5A5',
    backgroundColor: '#FEF2F2',
  },
  actionChipText: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  actionChipTextActive: {
    color: '#B91C1C',
  },
  notesText: {
    ...typography.body,
    color: colors.textPrimary,
    lineHeight: 22,
  },
  emptyText: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  listCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: radius.sm,
    padding: spacing.sm,
    backgroundColor: '#F8FAFC',
  },
  listCardMain: {
    flex: 1,
    gap: 2,
  },
  listCardSide: {
    alignItems: 'flex-end',
    gap: 4,
  },
  listCardTitle: {
    ...typography.sub,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  listCardSubtitle: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  listCardAmount: {
    ...typography.sub,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  timelineItem: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  timelineIcon: {
    marginTop: 2,
  },
  timelineBody: {
    flex: 1,
    gap: 2,
  },
  timelineTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  timelineTitle: {
    ...typography.sub,
    color: colors.textPrimary,
    fontWeight: '600',
    flex: 1,
  },
  timelineSubtitle: {
    ...typography.caption,
    color: colors.textPrimary,
  },
  timelineMeta: {
    ...typography.caption,
    color: colors.muted,
  },
  timelineBadge: {
    ...typography.caption,
    color: colors.textSecondary,
    backgroundColor: '#F1F5F9',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    fontWeight: '600',
  },
  activityItem: {
    borderLeftWidth: 3,
    borderLeftColor: colors.info,
    paddingLeft: spacing.sm,
    gap: 2,
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  statCell: {
    width: '47%',
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: radius.sm,
    padding: spacing.sm,
    backgroundColor: '#F8FAFC',
  },
  statValue: {
    ...typography.h3,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  statLabel: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  assignButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  assignButtonText: {
    ...typography.caption,
    color: colors.brandPrimary,
    fontWeight: '700',
  },
  sectionTitle: {
    ...typography.sub,
    color: colors.textPrimary,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  emptyAttachments: {
    ...typography.caption,
    color: colors.textSecondary,
    textAlign: 'center',
    marginTop: spacing.sm,
  },
  attachmentRow: {
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  attachmentCard: {
    flex: 1,
    aspectRatio: 1,
    backgroundColor: colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.divider,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  attachmentImage: {
    width: '100%',
    height: '100%',
    backgroundColor: '#E5E7EB',
  },
  attachmentIconWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#F8FAFC',
  },
  attachmentFileBadge: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  viewerRoot: {
    flex: 1,
    backgroundColor: '#000',
  },
  viewerClose: {
    marginTop: spacing.lg,
    marginHorizontal: spacing.md,
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: '#fff',
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  viewerCloseText: {
    ...typography.sub,
    color: '#fff',
    fontWeight: '600',
  },
  viewerImage: {
    flex: 1,
    width: '100%',
  },
  viewerVideo: {
    flex: 1,
    width: '100%',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.45)',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  modalCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    maxHeight: '75%',
  },
  modalTitle: {
    ...typography.h3,
    color: colors.textPrimary,
    marginBottom: spacing.sm,
  },
  modalScroll: {
    maxHeight: 360,
  },
  modalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  modalRowActive: {
    backgroundColor: '#F8FAFC',
  },
  modalRowTitle: {
    ...typography.sub,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  modalRowMeta: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  modalCloseButton: {
    marginTop: spacing.sm,
    alignSelf: 'flex-end',
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  modalCloseText: {
    ...typography.sub,
    color: colors.textPrimary,
    fontWeight: '600',
  },
})
