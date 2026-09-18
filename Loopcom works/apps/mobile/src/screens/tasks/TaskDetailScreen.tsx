import React, { useState } from 'react'
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
import { TasksStackParamList } from '../../types/navigation'
import { useAuth } from '../../auth/AuthContext'
import { useOnlineState } from '../../hooks/useOnlineState'
import { enqueueOutbox } from '../../offline/outbox'
import { normalizeAttachmentUrl } from '../../services/open-attachment'
import { AttachmentGalleryModal } from '../../components/attachments/AttachmentGalleryModal'
import { AttachmentOpenPressable } from '../../components/attachments/AttachmentOpenPressable'

type Props = NativeStackScreenProps<TasksStackParamList, 'TaskDetail'>

interface TaskDetailResponse {
  task: any
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

interface TaskNotesResponse {
  notes: Array<{
    id: string
    content: string
    createdAt: string
    authorName?: string
  }>
}

export function TaskDetailScreen({ route }: Props) {
  const { taskId } = route.params
  const queryClient = useQueryClient()
  const [noteText, setNoteText] = useState('')
  const [galleryVisible, setGalleryVisible] = useState(false)
  const [galleryIndex, setGalleryIndex] = useState(0)
  const { token } = useAuth()
  const isOnline = useOnlineState()

  const taskQuery = useQuery({
    queryKey: ['mobile-task-detail', taskId],
    queryFn: () => apiRequest<TaskDetailResponse>(`/api/tasks/${taskId}`),
    refetchInterval: 45_000,
  })

  const attachmentsQuery = useQuery({
    queryKey: ['mobile-task-attachments', taskId],
    queryFn: () => apiRequest<AttachmentResponse>(`/api/attachments?entityType=task&entityId=${taskId}`),
    refetchInterval: 45_000,
  })

  const notesQuery = useQuery({
    queryKey: ['mobile-task-notes', taskId],
    queryFn: () => apiRequest<TaskNotesResponse>(`/api/tasks/${taskId}/notes`),
    refetchInterval: 45_000,
  })

  const updateMutation = useMutation({
    mutationFn: async (payload: { status?: string; description?: string }) => {
      if (!isOnline && payload.status) {
        await enqueueOutbox({
          id: `${Date.now()}-task-status-${taskId}`,
          type: 'task-status',
          payload: {
            taskId,
            status: payload.status,
          },
        })
        return
      }
      await apiRequest(`/api/tasks/${taskId}`, 'PUT', payload)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mobile-task-detail', taskId] })
      queryClient.invalidateQueries({ queryKey: ['mobile-tasks'] })
      queryClient.invalidateQueries({ queryKey: ['mobile-assignments'] })
    },
  })

  const addNoteMutation = useMutation({
    mutationFn: async () => {
      if (!noteText.trim()) return
      if (!isOnline) {
        throw new Error('Cannot add notes while offline. Please reconnect and try again.')
      }
      await apiRequest(`/api/tasks/${taskId}/notes`, 'POST', { content: noteText.trim() })
    },
    onSuccess: () => {
      setNoteText('')
      queryClient.invalidateQueries({ queryKey: ['mobile-task-notes', taskId] })
      queryClient.invalidateQueries({ queryKey: ['mobile-task-detail', taskId] })
      queryClient.invalidateQueries({ queryKey: ['mobile-tasks'] })
      queryClient.invalidateQueries({ queryKey: ['mobile-assignments'] })
    },
  })

  const task = taskQuery.data?.task
  const notes = notesQuery.data?.notes || []

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
            const fileName = asset.fileName || `task-${taskId}-${Date.now()}`
            await uploadTaskFile({
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
            await uploadTaskFile({
              uri: file.uri,
              mimeType: file.mimeType || 'application/octet-stream',
              fileName: file.name || `task-${taskId}-${Date.now()}`,
              fileSize: file.size || 0,
            })
          })()
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ])
  }

  const uploadTaskFile = async (asset: {
    uri: string
    mimeType: string
    fileName: string
    fileSize: number
  }) => {
    if (!token) return
    const { uri, mimeType, fileName, fileSize } = asset
    if (!isOnline) {
      await enqueueOutbox({
        id: `${Date.now()}-task-media-${taskId}`,
        type: 'entity-media',
        payload: {
          entityType: 'task',
          entityId: taskId,
          uri,
          mimeType,
          fileName,
          fileSize,
        },
      })
      queryClient.invalidateQueries({ queryKey: ['mobile-task-attachments', taskId] })
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
      entityType: 'task',
      entityId: taskId,
      fileName,
      url: payload.url,
      key: payload.filename || payload.url,
      mimeType,
      fileSize,
    })
    queryClient.invalidateQueries({ queryKey: ['mobile-task-attachments', taskId] })
  }

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {!task ? (
          <Text style={styles.empty}>Loading task...</Text>
        ) : (
          <>
            <Text style={styles.title}>{task.title}</Text>
            <StatusChip status={task.status} />
            <Text style={styles.meta}>Priority: {task.priority}</Text>
            <Text style={styles.meta}>Scheduled: {task.dueDate ? new Date(task.dueDate).toLocaleString() : 'Optional / Unscheduled'}</Text>
            <Text style={styles.meta}>Assignee: {task.assignee ? `${task.assignee.firstName} ${task.assignee.lastName}` : 'N/A'}</Text>
            <Text style={styles.meta}>Client: {task.client?.name || 'Unattached'}</Text>

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Description</Text>
              <Text style={styles.body}>{task.description || 'No description'}</Text>
            </View>

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Actions</Text>
              <View style={styles.row}>
                <Pressable style={styles.secondaryButton} onPress={() => updateMutation.mutate({ status: 'IN_PROGRESS' })}>
                  <Text style={styles.secondaryButtonText}>Start</Text>
                </Pressable>
                <Pressable style={styles.primaryButton} onPress={() => updateMutation.mutate({ status: 'COMPLETED' })}>
                  <Text style={styles.primaryButtonText}>Complete</Text>
                </Pressable>
              </View>
            </View>

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Notes</Text>
              <TextInput
                value={noteText}
                onChangeText={setNoteText}
                multiline
                style={styles.input}
                placeholder="Write a note..."
              />
              <Pressable
                style={[styles.secondaryButton, (!noteText.trim() || addNoteMutation.isPending) && styles.disabledButton]}
                onPress={() => addNoteMutation.mutate()}
                disabled={!noteText.trim() || addNoteMutation.isPending}
              >
                <Text style={styles.secondaryButtonText}>{addNoteMutation.isPending ? 'Saving...' : 'Add Note'}</Text>
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
        entityType="task"
        entityId={taskId}
        onAttachmentCreated={() => {
          queryClient.invalidateQueries({ queryKey: ['mobile-task-attachments', taskId] })
        }}
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  content: { padding: 14, gap: 10, paddingBottom: 40 },
  empty: { textAlign: 'center', marginTop: 30, color: BRAND.muted },
  title: { fontSize: 22, fontWeight: '800', color: BRAND.text },
  meta: { fontSize: 13, color: BRAND.muted },
  section: { backgroundColor: BRAND.white, borderRadius: 12, padding: 12, gap: 8 },
  sectionTitle: { color: BRAND.text, fontWeight: '700', fontSize: 15 },
  body: { color: BRAND.text, lineHeight: 20 },
  row: { flexDirection: 'row', gap: 8 },
  input: {
    minHeight: 90,
    borderWidth: 1,
    borderColor: '#D0D5DD',
    borderRadius: 10,
    padding: 10,
    textAlignVertical: 'top',
    color: BRAND.text,
  },
  primaryButton: { backgroundColor: BRAND.primary, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 14 },
  primaryButtonText: { color: BRAND.white, fontWeight: '700' },
  secondaryButton: {
    borderColor: '#D0D5DD',
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignSelf: 'flex-start',
  },
  secondaryButtonText: { color: BRAND.text, fontWeight: '600' },
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

