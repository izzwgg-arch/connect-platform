import React, { useEffect, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useQuery } from '@tanstack/react-query'
import { useShareIntentContext } from 'expo-share-intent'
import { AppScreen } from '../../components/AppScreen'
import { Card } from '../../components/Card'
import { EmptyState } from '../../components/EmptyState'
import { apiRequest } from '../../api/client'
import { JobsStackParamList } from '../../types/navigation'
import { colors, radius, spacing, typography } from '../../theme/tokens'
import { useMobilePermissions } from '../../hooks/useMobilePermissions'
import {
  fileTypeIconName,
  formatFileSize,
  LocalAttachmentFile,
  pickAttachmentsByAction,
  uploadFileWithProgress,
} from '../../services/attachment-upload'

type Props = NativeStackScreenProps<JobsStackParamList, 'ShareIngress'>

type ShareTargetType = 'job' | 'request' | 'message'

interface MobileJobListItem {
  id: string
  jobNumber: string
  title: string
  status: string
  client: { id: string; name: string } | null
}

interface JobsListResponse {
  jobs: MobileJobListItem[]
}

interface MobileRequestListItem {
  id: string
  firstName: string
  lastName: string
  status: string
}

interface RequestsListResponse {
  leads: MobileRequestListItem[]
}

type ShareIngressListItem = MobileJobListItem | MobileRequestListItem

function isRequestItem(item: ShareIngressListItem): item is MobileRequestListItem {
  return 'firstName' in item
}

function guessKind(mimeType: string): LocalAttachmentFile['kind'] {
  const mime = mimeType.toLowerCase()
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return 'document'
}

function buildFileFromParts(parts: {
  uri?: string | null
  name?: string | null
  mimeType?: string | null
  size?: number | string | null
}): LocalAttachmentFile | null {
  if (!parts.uri) return null
  const mimeType = String(parts.mimeType || '').trim() || 'application/octet-stream'
  const name =
    String(parts.name || '').trim() ||
    decodeURIComponent(parts.uri.split('/').pop() || '') ||
    `shared-${Date.now()}`
  return {
    localId: `share-${Date.now()}`,
    uri: parts.uri,
    name,
    mimeType,
    sizeBytes: Number(parts.size || 0),
    kind: guessKind(mimeType),
  }
}

function buildFileFromRouteParams(params: Props['route']['params']): LocalAttachmentFile | null {
  return buildFileFromParts({
    uri: params?.uri,
    name: params?.name,
    mimeType: params?.mimeType,
    size: params?.size,
  })
}

const TARGET_OPTIONS: Array<{ type: ShareTargetType; label: string; icon: keyof typeof Ionicons.glyphMap }> = [
  { type: 'job', label: 'Job', icon: 'briefcase-outline' },
  { type: 'request', label: 'Request', icon: 'document-text-outline' },
  { type: 'message', label: 'Message', icon: 'chatbubble-ellipses-outline' },
]

export function ShareIngressScreen({ route, navigation }: Props) {
  const { canViewAllJobs, canViewRequests, canUseMessaging } = useMobilePermissions()
  const allowRequests = canViewRequests()
  const allowMessaging = canUseMessaging()
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext()

  const [sharedFile, setSharedFile] = useState<LocalAttachmentFile | null>(() => buildFileFromRouteParams(route.params))
  const [targetType, setTargetType] = useState<ShareTargetType>('job')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300)
    return () => clearTimeout(timer)
  }, [search])


  useEffect(() => {
    const fromParams = buildFileFromRouteParams(route.params)
    if (fromParams) setSharedFile(fromParams)
  }, [route.params])

  useEffect(() => {
    if (!hasShareIntent) return
    const first = shareIntent?.files?.[0]
    if (!first?.path) return
    const file = buildFileFromParts({
      uri: first.path,
      name: first.fileName,
      mimeType: first.mimeType,
      size: first.size,
    })
    if (file) setSharedFile(file)
  }, [hasShareIntent, shareIntent])

  useEffect(() => {
    if (targetType === 'request' && !allowRequests) setTargetType('job')
    if (targetType === 'message' && !allowMessaging) setTargetType('job')
  }, [allowRequests, allowMessaging, targetType])

  const jobsFilter = canViewAllJobs() ? 'all' : 'assigned'
  const jobsQuery = useQuery({
    queryKey: ['share-ingress-jobs', jobsFilter, debouncedSearch],
    queryFn: () => {
      const params = new URLSearchParams({
        limit: '100',
        filter: jobsFilter,
        sort: 'recent',
      })
      if (debouncedSearch) params.set('search', debouncedSearch)
      return apiRequest<JobsListResponse>(`/api/mobile/jobs?${params.toString()}`)
    },
    enabled: targetType === 'job' || targetType === 'message',
  })

  const requestsQuery = useQuery({
    queryKey: ['share-ingress-requests', debouncedSearch],
    queryFn: () =>
      apiRequest<RequestsListResponse>(
        `/api/leads?search=${encodeURIComponent(debouncedSearch)}&limit=20`
      ),
    enabled: targetType === 'request' && allowRequests,
  })

  const filteredJobs = jobsQuery.data?.jobs || []
  const requests = requestsQuery.data?.leads || []

  const onPickTestFile = async () => {
    const files = await pickAttachmentsByAction('choose-document')
    if (files.length > 0) setSharedFile(files[0])
  }

  const canSubmit =
    !!sharedFile &&
    !isUploading &&
    ((targetType === 'job' && !!selectedJobId) ||
      (targetType === 'message' && !!selectedJobId) ||
      (targetType === 'request' && !!selectedRequestId))

  const onAttach = async () => {
    if (!sharedFile) return
    setIsUploading(true)
    setUploadProgress(0)
    try {
      if (targetType === 'job') {
        if (!selectedJobId) return
        await uploadFileWithProgress(`/api/jobs/${selectedJobId}/attachments`, sharedFile, setUploadProgress).promise
        resetShareIntent()
        Alert.alert('Attached', 'The shared file was attached to the job.')
        navigation.replace('JobDetail', { jobId: selectedJobId })
        return
      }

      if (targetType === 'request') {
        if (!selectedRequestId) return
        await uploadFileWithProgress(`/api/requests/${selectedRequestId}/attachments`, sharedFile, setUploadProgress)
          .promise
        resetShareIntent()
        Alert.alert('Attached', 'The shared file was attached to the request.')
        navigation.replace('RequestDetail', { requestId: selectedRequestId })
        return
      }

      if (!selectedJobId) return
      const thread = await apiRequest<{ conversationId: string }>('/api/messages/job/ensure', 'POST', {
        jobId: selectedJobId,
      })
      const uploaded = await uploadFileWithProgress<{ url: string }>(
        '/api/uploads/messages',
        sharedFile,
        setUploadProgress
      ).promise
      const url = uploaded.raw?.url
      if (!url) throw new Error('Upload did not return a file URL')
      const kind = sharedFile.mimeType.startsWith('image/')
        ? 'IMAGE'
        : sharedFile.mimeType.startsWith('video/')
          ? 'VIDEO'
          : 'FILE'
      await apiRequest(`/api/messages/conversations/${thread.conversationId}/messages`, 'POST', {
        text: null,
        jobId: selectedJobId,
        attachments: [
          {
            kind,
            url,
            fileName: sharedFile.name,
            mimeType: sharedFile.mimeType,
            sizeBytes: sharedFile.sizeBytes || null,
          },
        ],
      })
      resetShareIntent()
      Alert.alert('Sent', 'The shared file was posted to the job chat.')
      const parentNav: any = navigation.getParent()?.getParent() || navigation.getParent()
      parentNav?.navigate('MainTabs', {
        screen: 'MessagesTab',
        params: { screen: 'MessageThread', params: { conversationId: thread.conversationId } },
      })
    } catch (error: any) {
      Alert.alert('Failed', error?.message || 'Could not attach the shared file.')
    } finally {
      setIsUploading(false)
    }
  }

  return (
    <AppScreen>
      <FlatList<ShareIngressListItem>
        style={styles.list}
        data={targetType === 'request' ? requests : filteredJobs}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          <View style={styles.header}>
            <Card>
              <Text style={styles.sectionTitle}>Shared file</Text>
              {sharedFile ? (
                <View style={styles.fileRow}>
                  <View style={styles.fileIconWrap}>
                    <Ionicons
                      name={fileTypeIconName(sharedFile) as keyof typeof Ionicons.glyphMap}
                      size={22}
                      color={colors.brandPrimary}
                    />
                  </View>
                  <View style={styles.fileInfo}>
                    <Text style={styles.fileName} numberOfLines={2}>
                      {sharedFile.name}
                    </Text>
                    <Text style={styles.fileMeta}>
                      {sharedFile.mimeType} • {formatFileSize(sharedFile.sizeBytes)}
                    </Text>
                  </View>
                  <Pressable onPress={onPickTestFile} style={styles.changeButton}>
                    <Text style={styles.changeButtonText}>Change</Text>
                  </Pressable>
                </View>
              ) : (
                <View>
                  <Text style={styles.emptyFileText}>
                    No file was shared into this screen. Choose one to test the attach flow.
                  </Text>
                  <Pressable style={styles.pickButton} onPress={onPickTestFile}>
                    <Ionicons name="attach-outline" size={18} color={colors.surface} />
                    <Text style={styles.pickButtonText}>Choose a file</Text>
                  </Pressable>
                </View>
              )}
            </Card>

            <Card style={styles.targetCard}>
              <Text style={styles.sectionTitle}>Attach to</Text>
              <View style={styles.segmentRow}>
                {TARGET_OPTIONS.filter((option) => option.type !== 'request' || allowRequests)
                  .filter((option) => option.type !== 'message' || allowMessaging)
                  .map((option) => {
                    const active = targetType === option.type
                    return (
                      <Pressable
                        key={option.type}
                        onPress={() => {
                          setTargetType(option.type)
                          setSearch('')
                        }}
                        style={[styles.segmentButton, active && styles.segmentButtonActive]}
                      >
                        <Ionicons
                          name={option.icon}
                          size={16}
                          color={active ? colors.surface : colors.textSecondary}
                        />
                        <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{option.label}</Text>
                      </Pressable>
                    )
                  })}
              </View>

              <TextInput
                value={search}
                onChangeText={(value) => {
                  setSearch(value)
                  setSelectedJobId(null)
                  setSelectedRequestId(null)
                }}
                placeholder={
                  targetType === 'request'
                    ? 'Search requests by name...'
                    : 'Search jobs by number, title, or client...'
                }
                placeholderTextColor={colors.muted}
                style={styles.searchInput}
              />
              {(targetType === 'job' || targetType === 'message') && !canViewAllJobs() ? (
                <Text style={styles.scopeHint}>Showing jobs assigned to you. Search finds matching assigned jobs.</Text>
              ) : null}
            </Card>

            {(targetType === 'job' || targetType === 'message') && jobsQuery.isLoading ? (
              <ActivityIndicator style={styles.loader} color={colors.brandPrimary} />
            ) : null}
            {targetType === 'request' && requestsQuery.isLoading ? (
              <ActivityIndicator style={styles.loader} color={colors.brandPrimary} />
            ) : null}
          </View>
        }
        renderItem={({ item }) => {
          if (isRequestItem(item)) {
            const request = item
            const selected = selectedRequestId === request.id
            return (
              <Pressable
                onPress={() => setSelectedRequestId(request.id)}
                style={[styles.resultRow, selected && styles.resultRowSelected]}
              >
                <Ionicons
                  name={selected ? 'radio-button-on' : 'radio-button-off'}
                  size={18}
                  color={selected ? colors.brandPrimary : colors.muted}
                />
                <View style={styles.resultInfo}>
                  <Text style={styles.resultTitle}>
                    {request.firstName} {request.lastName}
                  </Text>
                  <Text style={styles.resultSubtitle}>{request.status}</Text>
                </View>
              </Pressable>
            )
          }

          const job = item
          const selected = selectedJobId === job.id
          return (
            <Pressable
              onPress={() => setSelectedJobId(job.id)}
              style={[styles.resultRow, selected && styles.resultRowSelected]}
            >
              <Ionicons
                name={selected ? 'radio-button-on' : 'radio-button-off'}
                size={18}
                color={selected ? colors.brandPrimary : colors.muted}
              />
              <View style={styles.resultInfo}>
                <Text style={styles.resultTitle}>
                  #{job.jobNumber} • {job.title}
                </Text>
                <Text style={styles.resultSubtitle}>{job.client?.name || job.status}</Text>
              </View>
            </Pressable>
          )
        }}
        ListEmptyComponent={
          !jobsQuery.isLoading && !requestsQuery.isLoading ? (
            <EmptyState icon="search-outline" title="No matches" description="Try a different search term." />
          ) : null
        }
      />

      <View style={styles.footer}>
        {isUploading ? (
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${Math.round(uploadProgress * 100)}%` }]} />
          </View>
        ) : null}
        <Pressable
          style={[styles.submitButton, !canSubmit && styles.submitButtonDisabled]}
          onPress={onAttach}
          disabled={!canSubmit}
        >
          {isUploading ? (
            <ActivityIndicator color={colors.surface} />
          ) : (
            <Text style={styles.submitButtonText}>
              {targetType === 'message' ? 'Send to Job Chat' : 'Attach'}
            </Text>
          )}
        </Pressable>
      </View>
    </AppScreen>
  )
}

const styles = StyleSheet.create({
  list: { flex: 1 },
  header: { gap: spacing.sm, paddingTop: spacing.sm },
  listContent: { paddingBottom: spacing.xxl, gap: spacing.xs },
  sectionTitle: {
    ...typography.sub,
    color: colors.textPrimary,
    fontWeight: '700',
    marginBottom: spacing.xs,
  },
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  fileIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(46,74,89,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fileInfo: { flex: 1 },
  fileName: { ...typography.sub, color: colors.textPrimary, fontWeight: '600' },
  fileMeta: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  changeButton: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.divider,
  },
  changeButtonText: { ...typography.caption, color: colors.brandPrimary, fontWeight: '600' },
  emptyFileText: { ...typography.caption, color: colors.textSecondary, marginBottom: spacing.sm },
  pickButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    backgroundColor: colors.brandPrimary,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
  },
  pickButtonText: { ...typography.sub, color: colors.surface, fontWeight: '700' },
  targetCard: { gap: spacing.sm },
  segmentRow: { flexDirection: 'row', gap: spacing.xs },
  segmentButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.divider,
  },
  segmentButtonActive: { backgroundColor: colors.brandPrimary, borderColor: colors.brandPrimary },
  segmentText: { ...typography.caption, color: colors.textSecondary, fontWeight: '600' },
  segmentTextActive: { color: colors.surface },
  scopeHint: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
  searchInput: {
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    color: colors.textPrimary,
    ...typography.sub,
  },
  loader: { marginTop: spacing.sm },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: radius.md,
    padding: spacing.sm,
  },
  resultRowSelected: { borderColor: colors.brandPrimary, backgroundColor: 'rgba(46,74,89,0.06)' },
  resultInfo: { flex: 1 },
  resultTitle: { ...typography.sub, color: colors.textPrimary, fontWeight: '600' },
  resultSubtitle: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  footer: {
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
    backgroundColor: colors.background,
    gap: spacing.xs,
  },
  progressTrack: { height: 4, borderRadius: 999, backgroundColor: colors.divider },
  progressFill: { height: 4, borderRadius: 999, backgroundColor: colors.brandPrimary },
  submitButton: {
    minHeight: 48,
    borderRadius: radius.md,
    backgroundColor: colors.brandPrimary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitButtonDisabled: { opacity: 0.5 },
  submitButtonText: { ...typography.sub, color: colors.surface, fontWeight: '700' },
})
