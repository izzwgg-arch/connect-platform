import React from 'react'
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as ImagePicker from 'expo-image-picker'
import * as DocumentPicker from 'expo-document-picker'
import * as FileSystem from 'expo-file-system/legacy'
import { Screen } from '../../components/Screen'
import { apiRequest } from '../../api/client'
import { StatusChip } from '../../components/StatusChip'
import { API_BASE_URL, BRAND } from '../../config/env'
import { IssuesStackParamList } from '../../types/navigation'
import { useAuth } from '../../auth/AuthContext'
import { useOnlineState } from '../../hooks/useOnlineState'
import { enqueueOutbox } from '../../offline/outbox'
import { AttachmentGalleryModal } from '../../components/attachments/AttachmentGalleryModal'
import { AttachmentOpenPressable } from '../../components/attachments/AttachmentOpenPressable'
import { normalizeAttachmentUrl } from '../../services/open-attachment'

type Props = NativeStackScreenProps<IssuesStackParamList, 'IssueDetail'>

interface IssueDetailResponse {
  issue: any
}

interface AttachmentResponse {
  attachments: Array<{
    id: string
    fileName: string
    fileSize: number
    mimeType?: string | null
    url?: string | null
  }>
}

interface IssueNotesResponse {
  notes: Array<{
    id: string
    content: string
    createdById: string
    createdAt: string
    authorName?: string
  }>
}

export function IssueDetailScreen({ route, navigation }: Props) {
  const { issueId } = route.params
  const queryClient = useQueryClient()
  const [noteText, setNoteText] = React.useState('')
  const [galleryVisible, setGalleryVisible] = React.useState(false)
  const [galleryIndex, setGalleryIndex] = React.useState(0)
  const { token, user } = useAuth()
  const isOnline = useOnlineState()
  const issueQuery = useQuery({
    queryKey: ['mobile-issue-detail', issueId],
    queryFn: () => apiRequest<IssueDetailResponse>(`/api/issues/${issueId}`),
    refetchInterval: 45_000,
  })

  const attachmentsQuery = useQuery({
    queryKey: ['mobile-issue-attachments', issueId],
    queryFn: () => apiRequest<AttachmentResponse>(`/api/attachments?entityType=issue&entityId=${issueId}`),
    refetchInterval: 45_000,
  })

  const notesQuery = useQuery({
    queryKey: ['mobile-issue-notes', issueId],
    queryFn: () => apiRequest<IssueNotesResponse>(`/api/issues/${issueId}/notes`),
    refetchInterval: 45_000,
  })

  const updateMutation = useMutation({
    mutationFn: async (status: string) => {
      if (!isOnline) {
        await enqueueOutbox({
          id: `${Date.now()}-issue-status-${issueId}`,
          type: 'issue-status',
          payload: { issueId, status },
        })
        return
      }
      await apiRequest(`/api/issues/${issueId}`, 'PUT', { status })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mobile-issue-detail', issueId] })
      queryClient.invalidateQueries({ queryKey: ['mobile-issues'] })
      queryClient.invalidateQueries({ queryKey: ['mobile-assignments'] })
    },
  })

  const addNoteMutation = useMutation({
    mutationFn: async () => {
      if (!noteText.trim()) return
      if (!isOnline) {
        throw new Error('Cannot add notes while offline. Please reconnect and try again.')
      }
      await apiRequest(`/api/issues/${issueId}/notes`, 'POST', {
        content: noteText.trim(),
        isInternal: false,
      })
    },
    onSuccess: () => {
      setNoteText('')
      queryClient.invalidateQueries({ queryKey: ['mobile-issue-notes', issueId] })
      queryClient.invalidateQueries({ queryKey: ['mobile-issue-detail', issueId] })
      queryClient.invalidateQueries({ queryKey: ['mobile-issues'] })
      queryClient.invalidateQueries({ queryKey: ['mobile-assignments'] })
    },
    onError: (error: any) => {
      Alert.alert('Unable to add note', error?.message || 'Failed to add note')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await apiRequest(`/api/issues/${issueId}?mobile=true`, 'DELETE')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mobile-issues'] })
      queryClient.invalidateQueries({ queryKey: ['mobile-assignments'] })
      navigation.goBack()
    },
  })

  const issue = issueQuery.data?.issue
  const notes = notesQuery.data?.notes || []
  const canDeleteOwnIssue = Boolean(user?.id && issue?.createdById === user.id)

  const uploadAttachment = async () => {
    if (!token) return

    Alert.alert('Add attachment', 'Choose what to upload', [
      {
        text: 'Photo / Video',
        onPress: () => {
          void (async () => {
            const permission = await ImagePicker.requestMediaLibraryPermissionsAsync()
            if (!permission.granted) return
            const result = await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ['images', 'videos'],
              quality: 0.72,
            })
            if (result.canceled || result.assets.length === 0) return
            const asset = result.assets[0]
            const mimeType = asset.mimeType || (asset.type === 'video' ? 'video/mp4' : 'image/jpeg')
            const fileName = asset.fileName || `issue-${issueId}-${Date.now()}`
            await uploadIssueFile({
              uri: asset.uri,
              mimeType,
              fileName,
              fileSize: asset.fileSize || 0,
            })
          })()
        },
      },
      {
        text: 'File (PDF, MP3, MP4…)',
        onPress: () => {
          void (async () => {
            const result = await DocumentPicker.getDocumentAsync({
              copyToCacheDirectory: true,
              multiple: false,
              type: ['*/*', 'audio/*', 'video/*', 'image/*', 'application/pdf'],
            })
            if (result.canceled || result.assets.length === 0) return
            const file = result.assets[0]
            await uploadIssueFile({
              uri: file.uri,
              mimeType: file.mimeType || 'application/octet-stream',
              fileName: file.name || `issue-${issueId}-${Date.now()}`,
              fileSize: file.size || 0,
            })
          })()
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ])
  }

  const uploadIssueFile = async (asset: {
    uri: string
    mimeType: string
    fileName: string
    fileSize: number
  }) => {
    if (!token) return
    const { uri, mimeType, fileName, fileSize } = asset
    if (!isOnline) {
      await enqueueOutbox({
        id: `${Date.now()}-issue-media-${issueId}`,
        type: 'entity-media',
        payload: {
          entityType: 'issue',
          entityId: issueId,
          uri,
          mimeType,
          fileName,
          fileSize,
        },
      })
      queryClient.invalidateQueries({ queryKey: ['mobile-issue-attachments', issueId] })
      return
    }
    const upload = await FileSystem.uploadAsync(`${API_BASE_URL}/api/uploads`, uri, {
      fieldName: 'file',
      httpMethod: 'POST',
      uploadType: FileSystem.FileSystemUploadType.MULTIPART,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      mimeType,
    })
    if (upload.status < 200 || upload.status >= 300) return
    const payload = JSON.parse(upload.body)
    await apiRequest('/api/attachments', 'POST', {
      entityType: 'issue',
      entityId: issueId,
      fileName,
      url: payload.url,
      key: payload.filename || payload.url,
      mimeType,
      fileSize,
    })
    queryClient.invalidateQueries({ queryKey: ['mobile-issue-attachments', issueId] })
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        {!issue ? (
          <Text style={styles.empty}>Loading issue...</Text>
        ) : (
          <>
            <Text style={styles.title}>{issue.title}</Text>
            <StatusChip status={issue.status} />
            <Text style={styles.meta}>Type: {issue.type}</Text>
            <Text style={styles.meta}>Priority: {issue.priority}</Text>
            <Text style={styles.meta}>Scheduled: {issue.dueDate ? new Date(issue.dueDate).toLocaleString() : 'Optional / Unscheduled'}</Text>
            <Text style={styles.meta}>Client: {issue.client?.name || 'Unattached'}</Text>
            <Text style={styles.meta}>
              Job: {issue.job ? `${issue.job.jobNumber} - ${issue.job.title}` : 'No linked job'}
            </Text>
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Description</Text>
              <Text style={styles.body}>{issue.description || 'No description'}</Text>
            </View>
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Actions</Text>
              <View style={styles.row}>
                <Pressable style={styles.secondaryButton} onPress={() => updateMutation.mutate('IN_PROGRESS')}>
                  <Text style={styles.secondaryButtonText}>Start</Text>
                </Pressable>
                <Pressable style={styles.secondaryButton} onPress={() => updateMutation.mutate('CLOSED')}>
                  <Text style={styles.secondaryButtonText}>Close</Text>
                </Pressable>
                <Pressable style={styles.primaryButton} onPress={() => updateMutation.mutate('RESOLVED')}>
                  <Text style={styles.primaryButtonText}>Resolve</Text>
                </Pressable>
                {canDeleteOwnIssue && (
                  <Pressable
                    style={styles.dangerButton}
                    onPress={() => {
                      Alert.alert(
                        'Delete issue',
                        'Only issues you created can be deleted. Continue?',
                        [
                          { text: 'Cancel', style: 'cancel' },
                          {
                            text: deleteMutation.isPending ? 'Deleting...' : 'Delete',
                            style: 'destructive',
                            onPress: () => {
                              deleteMutation.mutate(undefined, {
                                onSuccess: () => {
                                  Alert.alert('Issue deleted', 'Issue has been removed from your queue.')
                                },
                                onError: (error: any) => {
                                  Alert.alert('Unable to delete issue', error?.message || 'Delete failed')
                                },
                              })
                            },
                          },
                        ]
                      )
                    }}
                  >
                    <Text style={styles.dangerButtonText}>Delete</Text>
                  </Pressable>
                )}
              </View>
            </View>

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Notes</Text>
              <TextInput
                style={[styles.input, styles.multilineInput]}
                placeholder="Write a note..."
                value={noteText}
                onChangeText={setNoteText}
                multiline
              />
              <Pressable
                style={[styles.primaryButton, (!noteText.trim() || addNoteMutation.isPending) && styles.disabledButton]}
                onPress={() => addNoteMutation.mutate()}
                disabled={!noteText.trim() || addNoteMutation.isPending}
              >
                <Text style={styles.primaryButtonText}>{addNoteMutation.isPending ? 'Saving...' : 'Add Note'}</Text>
              </Pressable>
              {notes.length === 0 ? (
                <Text style={styles.meta}>No notes yet.</Text>
              ) : (
                notes.map((note) => (
                  <View key={note.id} style={styles.noteRow}>
                    <Text style={styles.noteMeta}>
                      {note.authorName || 'User'} • {new Date(note.createdAt).toLocaleString()}
                    </Text>
                    <Text style={styles.body}>{note.content}</Text>
                  </View>
                ))
              )}
            </View>

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Attachments</Text>
              <Pressable style={styles.secondaryButton} onPress={uploadAttachment}>
                <Text style={styles.secondaryButtonText}>Attach Photo/Video</Text>
              </Pressable>
              {(attachmentsQuery.data?.attachments || []).map((a) => (
                <AttachmentOpenPressable
                  key={a.id}
                  attachment={a}
                  style={styles.attachmentRow}
                  onOpenGallery={() => {
                    const list = (attachmentsQuery.data?.attachments || []).filter((row) => !!row.url)
                    const idx = list.findIndex((row) => row.id === a.id)
                    if (idx < 0) return
                    setGalleryIndex(idx)
                    setGalleryVisible(true)
                  }}
                >
                  <Text style={styles.attachmentName}>{a.fileName}</Text>
                  <Text style={styles.attachmentMeta}>
                    {Math.round(a.fileSize / 1024)} KB{a.url ? ' · Tap to open' : ''}
                  </Text>
                </AttachmentOpenPressable>
              ))}
            </View>
          </>
        )}
      </ScrollView>

      <AttachmentGalleryModal
        visible={galleryVisible}
        attachments={(attachmentsQuery.data?.attachments || [])
          .filter((row) => !!row.url)
          .map((row) => ({
            id: row.id,
            fileName: row.fileName || 'Attachment',
            fileSize: row.fileSize,
            mimeType: row.mimeType || 'application/octet-stream',
            url: normalizeAttachmentUrl(row.url || '') || String(row.url),
          }))}
        index={galleryIndex}
        onClose={() => setGalleryVisible(false)}
        onIndexChange={setGalleryIndex}
        entityType="issue"
        entityId={issueId}
        onAttachmentCreated={() => {
          queryClient.invalidateQueries({ queryKey: ['mobile-issue-attachments', issueId] })
        }}
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  content: { padding: 14, gap: 10 },
  empty: { textAlign: 'center', marginTop: 30, color: BRAND.muted },
  title: { fontSize: 22, fontWeight: '800', color: BRAND.text },
  meta: { fontSize: 13, color: BRAND.muted },
  section: { backgroundColor: BRAND.white, borderRadius: 12, padding: 12, gap: 8 },
  sectionTitle: { color: BRAND.text, fontWeight: '700', fontSize: 15 },
  body: { color: BRAND.text, lineHeight: 20 },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  primaryButton: { backgroundColor: BRAND.primary, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 14 },
  primaryButtonText: { color: BRAND.white, fontWeight: '700' },
  secondaryButton: {
    borderColor: '#D0D5DD',
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  secondaryButtonText: { color: BRAND.text, fontWeight: '600' },
  dangerButton: {
    borderColor: '#FECACA',
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    backgroundColor: '#FEF2F2',
  },
  dangerButtonText: { color: '#B91C1C', fontWeight: '700' },
  input: {
    borderColor: '#D0D5DD',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: BRAND.text,
    backgroundColor: '#FFFFFF',
  },
  multilineInput: {
    minHeight: 88,
    textAlignVertical: 'top',
  },
  noteRow: {
    borderTopWidth: 1,
    borderColor: '#EAECF0',
    paddingTop: 8,
    gap: 4,
  },
  noteMeta: {
    color: BRAND.muted,
    fontSize: 12,
    fontWeight: '600',
  },
  disabledButton: {
    opacity: 0.6,
  },
  attachmentRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    borderColor: '#EAECF0',
    paddingTop: 8,
  },
  attachmentName: {
    color: BRAND.text,
    flex: 1,
    marginRight: 8,
  },
  attachmentMeta: {
    color: BRAND.muted,
    fontSize: 12,
  },
})

