import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  AppState,
  FlatList,
  GestureResponderEvent,
  Image,
  Linking,
  Modal as RNModal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import * as Haptics from 'expo-haptics'
import { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Ionicons } from '@expo/vector-icons'
import * as ImagePicker from 'expo-image-picker'
import * as DocumentPicker from 'expo-document-picker'
import * as FileSystem from 'expo-file-system/legacy'
import * as Location from 'expo-location'
import * as Contacts from 'expo-contacts'
import * as Clipboard from 'expo-clipboard'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { SafeAreaView } from 'react-native-safe-area-context'
import ReactNativeModal from 'react-native-modal'
import { API_BASE_URL } from '../../config/env'
import { apiRequest, getValidAccessToken } from '../../api/client'
import { ChatMessage, Conversation } from '../../types/models'
import { MessagesStackParamList } from '../../types/navigation'
import { useAuth } from '../../auth/AuthContext'
import { useOnlineState } from '../../hooks/useOnlineState'
import { enqueueOutbox } from '../../offline/outbox'
import { MessageBubble } from '../../components/chat/MessageBubble'
import { Composer } from '../../components/chat/Composer'
import { DateSeparator } from '../../components/chat/DateSeparator'
import { MediaViewer } from '../../components/chat/MediaViewer'
import { VoiceRecorder } from '../../services/voiceRecorder'
import { buildSendDraftSnapshot, toInvertedThreadItems } from './message-thread-utils'
import { colors, spacing, typography } from '../../theme/tokens'

type Props = NativeStackScreenProps<MessagesStackParamList, 'MessageThread'>

interface ThreadResponse {
  messages: ChatMessage[]
}

interface ConversationResponse {
  conversation: Conversation
}

interface ConversationsResponse {
  conversations: Conversation[]
}

interface OptimisticMessage {
  id: string
  clientTempId: string
  senderId: string
  text?: string | null
  type: 'TEXT' | 'MEDIA' | 'VOICE' | 'LOCATION'
  status: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED'
  createdAt: string
  attachments?: Array<{
    kind: 'IMAGE' | 'VIDEO' | 'FILE' | 'VOICE' | 'LOCATION'
    url: string
    fileName?: string | null
    mimeType?: string | null
    sizeBytes?: number | null
    durationMs?: number | null
    latitude?: number | null
    longitude?: number | null
  }>
  replyToMessageId?: string | null
  replyTo?: {
    messageId: string
    senderName: string
    textPreview: string
    type?: 'TEXT' | 'MEDIA' | 'VOICE' | 'LOCATION' | 'SYSTEM'
    createdAt?: string | null
  } | null
  jobId?: string | null
  jobNumber?: string | null
  jobName?: string | null
  isOptimistic: true
}

interface SendMutationInput {
  clientTempId: string
  outgoingText: string
  outgoingDrafts: Array<{
    kind: 'IMAGE' | 'VIDEO' | 'FILE' | 'VOICE' | 'LOCATION'
    url?: string
    fileName?: string
    mimeType?: string
    sizeBytes?: number
    durationMs?: number
    latitude?: number
    longitude?: number
    localUri?: string
  }>
  outgoingReplyTo: ChatMessage | null
}

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  heif: 'image/heif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
  '3gp': 'video/3gpp',
  '3g2': 'video/3gpp2',
  mp3: 'audio/mpeg',
  m4a: 'audio/m4a',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
}

function inferMimeTypeFromName(fileName?: string | null, fallback = 'application/octet-stream'): string {
  const ext = String(fileName || '')
    .split('.')
    .pop()
    ?.trim()
    .toLowerCase()
  if (!ext) return fallback
  return MIME_BY_EXTENSION[ext] || fallback
}

function extFromMimeType(mimeType: string): string {
  const normalized = String(mimeType || '').toLowerCase()
  if (normalized === 'image/jpeg') return 'jpg'
  if (normalized === 'image/png') return 'png'
  if (normalized === 'image/heic') return 'heic'
  if (normalized === 'image/heif') return 'heif'
  if (normalized === 'video/mp4') return 'mp4'
  if (normalized === 'video/quicktime') return 'mov'
  if (normalized === 'video/x-m4v') return 'm4v'
  if (normalized === 'video/webm') return 'webm'
  if (normalized === 'video/3gpp') return '3gp'
  if (normalized === 'video/3gpp2') return '3g2'
  if (normalized === 'audio/mpeg' || normalized === 'audio/mp3') return 'mp3'
  if (normalized === 'audio/m4a' || normalized === 'audio/mp4' || normalized === 'audio/x-m4a') return 'm4a'
  if (normalized === 'audio/wav' || normalized === 'audio/x-wav') return 'wav'
  if (normalized === 'application/pdf') return 'pdf'
  if (normalized === 'application/msword') return 'doc'
  if (normalized === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx'
  if (normalized === 'application/vnd.ms-excel') return 'xls'
  if (normalized === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'xlsx'
  if (normalized === 'text/csv') return 'csv'
  if (normalized === 'application/vnd.ms-powerpoint') return 'ppt'
  if (normalized === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return 'pptx'
  if (normalized === 'text/plain') return 'txt'
  return 'bin'
}

function ensureFileName(fileName: string | null | undefined, mimeType: string, prefix: string): string {
  const name = String(fileName || '').trim()
  if (name && name.includes('.')) return name
  return `${prefix}-${Date.now()}.${extFromMimeType(mimeType)}`
}

export function MessageThreadScreen({ route, navigation }: Props) {
  const { conversationId, jobContext } = route.params
  const { user, token } = useAuth()
  const isOnline = useOnlineState()
  const queryClient = useQueryClient()
  const listRef = useRef<FlatList>(null)
  const [text, setText] = useState(jobContext ? `Regarding Job #${jobContext.jobNumber} - ${jobContext.jobName}\n` : '')
  const [isRecordingUi, setIsRecordingUi] = useState(false)
  const [recordingLockedUi, setRecordingLockedUi] = useState(false)
  const recordingLockedRef = useRef(false)
  const [messageReactions, setMessageReactions] = useState<Record<string, Record<string, number>>>({})
  const [recordingDurationMs, setRecordingDurationMs] = useState(0)
  const [recordingWillCancel, setRecordingWillCancel] = useState(false)
  const [optimisticMessages, setOptimisticMessages] = useState<OptimisticMessage[]>([])
  const [replyFallbackByMessageId, setReplyFallbackByMessageId] = useState<Record<string, NonNullable<ChatMessage['replyTo']>>>({})
  const [showAttachMenu, setShowAttachMenu] = useState(false)
  const [showNewThreadModal, setShowNewThreadModal] = useState(false)
  const [newThreadTitle, setNewThreadTitle] = useState('')
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null)
  const [editingMessage, setEditingMessage] = useState<ChatMessage | null>(null)
  const [showMessageOptions, setShowMessageOptions] = useState(false)
  const [messageActionTarget, setMessageActionTarget] = useState<ChatMessage | OptimisticMessage | null>(null)
  const voiceRecorderRef = useRef<VoiceRecorder>(new VoiceRecorder())
  const recordingStartedAtRef = useRef<number | null>(null)
  const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pressStartRef = useRef<{ x: number; y: number } | null>(null)
  const pressSessionRef = useRef<number>(0)
  const stopInFlightRef = useRef(false)
  const pendingScrollAfterSendRef = useRef(false)
  const [viewingMedia, setViewingMedia] = useState<{ uri: string; fileName?: string | null; kind: 'IMAGE' | 'VIDEO' } | null>(null)
  const [mediaDrafts, setMediaDrafts] = useState<
    Array<{
      kind: 'IMAGE' | 'VIDEO' | 'FILE' | 'VOICE' | 'LOCATION'
      url?: string
      fileName?: string
      mimeType?: string
      sizeBytes?: number
      durationMs?: number
      latitude?: number
      longitude?: number
      localUri?: string
      uploadProgress?: number
    }>
  >([])
  const [composerDockHeight, setComposerDockHeight] = useState(56)
  /** Coalesce dock onLayout bursts (IME / nav bar) into one setState so inverted list paddingTop does not step twice on keyboard close. */
  const composerDockLayoutRafRef = useRef<number | null>(null)
  useEffect(() => {
    return () => {
      if (composerDockLayoutRafRef.current != null) {
        cancelAnimationFrame(composerDockLayoutRafRef.current)
      }
    }
  }, [])

  const uploadToMessages = useCallback(
    async (uri: string, mimeType: string) => {
      const token = await getValidAccessToken()
      if (!token) throw new Error('Authentication required')
      let copiedUploadUri: string | null = null

      let uploadUri = uri
      const needsUriCopy =
        uploadUri.startsWith('content://') ||
        uploadUri.startsWith('ph://') ||
        uploadUri.startsWith('assets-library://')
      if (needsUriCopy) {
        const baseDir = FileSystem.cacheDirectory || FileSystem.documentDirectory
        if (!baseDir) {
          throw new Error('Unable to prepare file for upload')
        }
        copiedUploadUri = `${baseDir}chat-upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        await FileSystem.copyAsync({ from: uploadUri, to: copiedUploadUri })
        uploadUri = copiedUploadUri
      }

      const runUpload = async (accessToken: string) => {
        const task = FileSystem.createUploadTask(
          `${API_BASE_URL}/api/uploads/messages`,
          uploadUri,
          {
            fieldName: 'file',
            httpMethod: 'POST',
            uploadType: FileSystem.FileSystemUploadType.MULTIPART,
            mimeType,
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: 'application/json',
            },
          },
          () => {}
        )
        return task.uploadAsync()
      }

      let uploadResult = await runUpload(token)
      if (uploadResult?.status === 401) {
        const refreshedToken = await getValidAccessToken(true)
        if (refreshedToken) {
          uploadResult = await runUpload(refreshedToken)
        }
      }
      if (!uploadResult || uploadResult.status < 200 || uploadResult.status >= 300) {
        throw new Error(`Upload failed with status ${uploadResult?.status || 0}`)
      }
      const payload = JSON.parse(uploadResult.body || '{}')
      if (!payload?.url) {
        throw new Error('Upload failed: missing URL')
      }
      if (copiedUploadUri) {
        void FileSystem.deleteAsync(copiedUploadUri, { idempotent: true }).catch(() => {})
      }
      return payload as { url: string }
    },
    []
  )

  const conversationQuery = useQuery({
    queryKey: ['mobile-chat-conversation', conversationId],
    queryFn: () => apiRequest<ConversationResponse>(`/api/messages/conversations/${conversationId}`),
    refetchInterval: 30_000,
  })

  const conversationsQuery = useQuery({
    queryKey: ['mobile-chat-conversations'],
    queryFn: () => apiRequest<ConversationsResponse>('/api/messages/conversations'),
    refetchInterval: 20_000,
  })

  const switchJobThreadMutation = useMutation({
    mutationFn: ({ jobId, targetConversationId, title }: { jobId: string; targetConversationId?: string; title?: string }) =>
      apiRequest<{
        conversationId: string
        conversation: Conversation
        threads: Array<{ id: string; title?: string | null }>
      }>('/api/messages/job/ensure', 'POST', {
        jobId,
        conversationId: targetConversationId,
        title,
      }),
    onSuccess: async (result) => {
      setShowNewThreadModal(false)
      setNewThreadTitle('')
      await queryClient.invalidateQueries({ queryKey: ['mobile-chat-conversations'] })
      const next = result.conversation
      navigation.replace('MessageThread', {
        conversationId: result.conversationId,
        jobContext: next.jobId
          ? {
              jobId: next.jobId,
              jobNumber: next.jobNumber || jobContext?.jobNumber || '',
              jobName: next.jobTitle || jobContext?.jobName || '',
            }
          : jobContext,
      })
    },
    onError: (error: any) => {
      Alert.alert('Job thread', error?.message || 'Unable to open this job thread.')
    },
  })

  const threadQuery = useQuery({
    queryKey: ['mobile-chat-thread', conversationId],
    queryFn: () => apiRequest<ThreadResponse>(`/api/messages/conversations/${conversationId}/messages?limit=80`),
    refetchInterval: 8_000,
  })

  useEffect(() => {
    apiRequest(`/api/messages/conversations/${conversationId}/read`, 'POST', {}).catch(() => {})
  }, [conversationId])

  useEffect(() => {
    voiceRecorderRef.current.ensurePermission(true).catch(() => {})
  }, [])

  useEffect(() => {
    if (threadQuery.data?.messages) {
      const fallbackFromMatched: Record<string, NonNullable<ChatMessage['replyTo']>> = {}
      setOptimisticMessages((prev) => {
        const serverIds = new Set(threadQuery.data!.messages.map((m) => m.id))
        const remaining = prev.filter((opt) => {
          if (serverIds.has(opt.id)) return false
          const matched = threadQuery.data!.messages.find((m) => m.clientTempId === opt.clientTempId)
          if (matched) {
            if (!matched.replyTo && opt.replyTo) {
              fallbackFromMatched[matched.id] = opt.replyTo
            }
            return false
          }
          return true
        })
        return remaining
      })
      setReplyFallbackByMessageId((prev) => {
        const next = { ...prev }
        for (const [messageId, reply] of Object.entries(fallbackFromMatched)) {
          next[messageId] = reply
        }
        for (const message of threadQuery.data!.messages) {
          if (message.replyTo) {
            next[message.id] = message.replyTo
          }
        }
        return next
      })
    }
  }, [threadQuery.data?.messages])

  useEffect(() => {
    if (!threadQuery.data?.messages || optimisticMessages.length === 0) return
    const nextFallback: Record<string, NonNullable<ChatMessage['replyTo']>> = {}
    for (const optimistic of optimisticMessages) {
      if (!optimistic.replyTo) continue
      const matched = threadQuery.data.messages.find((message) => message.clientTempId === optimistic.clientTempId)
      if (matched && !matched.replyTo) {
        nextFallback[matched.id] = optimistic.replyTo
      }
    }
    if (Object.keys(nextFallback).length > 0) {
      setReplyFallbackByMessageId((prev) => ({ ...prev, ...nextFallback }))
    }
  }, [threadQuery.data?.messages, optimisticMessages])

  const sendMutation = useMutation({
    mutationFn: async ({ clientTempId, outgoingText, outgoingDrafts, outgoingReplyTo }: SendMutationInput) => {
      const localAttachments = outgoingDrafts.filter((m) => m.localUri)
      const readyAttachments = outgoingDrafts.filter((m) => m.url)
      const trimmed = outgoingText.trim()
      if (!trimmed && localAttachments.length === 0 && readyAttachments.length === 0) return

      if (!isOnline) {
        await enqueueOutbox({
          id: `chat-${Date.now()}-${conversationId}`,
          type: 'message-send',
          payload: {
            conversationId,
            to: '',
            from: user?.id || '',
            body: trimmed,
            channel:
              conversationType === 'TEAM' || conversationType === 'JOB_THREAD' ? 'TEAM' : 'DM',
            media: readyAttachments.map((a) => ({
              type: a.kind.toLowerCase(),
              url: a.url!,
              mimeType: a.mimeType,
              size: a.sizeBytes,
              filename: a.fileName,
            })),
          },
        })
        return
      }

      const uploaded: typeof readyAttachments = [...readyAttachments]
      for (const attachment of localAttachments) {
        if (!attachment.localUri) continue
        try {
          const uploadMimeType =
            attachment.kind === 'VOICE'
              ? 'audio/mp4'
              : attachment.mimeType || inferMimeTypeFromName(attachment.fileName, 'application/octet-stream')
          const payload = await uploadToMessages(attachment.localUri, uploadMimeType)
          uploaded.push({
            ...attachment,
            url: payload.url,
          })
        } catch (error) {
          console.error('Upload error:', error)
          throw error
        }
      }

      await apiRequest(`/api/messages/conversations/${conversationId}/messages`, 'POST', {
        text: trimmed,
        jobId: jobContext?.jobId || null,
        clientTempId,
        replyToMessageId: outgoingReplyTo?.id || null,
        replyToSenderName: outgoingReplyTo
          ? `${outgoingReplyTo.sender?.firstName || ''} ${outgoingReplyTo.sender?.lastName || ''}`.trim() ||
            outgoingReplyTo.sender?.email ||
            'Unknown'
          : null,
        replyToText:
          outgoingReplyTo?.text ||
          (outgoingReplyTo?.attachments?.[0]?.kind === 'VOICE'
            ? 'Voice note'
            : outgoingReplyTo?.attachments?.[0]?.kind === 'IMAGE'
              ? 'Photo'
              : outgoingReplyTo?.attachments?.[0]?.kind === 'VIDEO'
                ? 'Video'
                : outgoingReplyTo?.attachments?.[0]?.kind === 'LOCATION'
                  ? 'Location'
                  : outgoingReplyTo?.attachments?.[0]?.fileName || ''),
        replyToType: outgoingReplyTo?.type || null,
        attachments: uploaded.map((attachment) => ({
          kind: attachment.kind,
          url: attachment.url,
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          durationMs: attachment.durationMs,
          latitude: attachment.latitude,
          longitude: attachment.longitude,
        })),
      })
    },
    onSuccess: async () => {
      setText('')
      setMediaDrafts([])
      setReplyTo(null)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['mobile-chat-thread', conversationId] }),
        queryClient.invalidateQueries({ queryKey: ['mobile-chat-conversations'] }),
      ])
      apiRequest(`/api/messages/conversations/${conversationId}/read`, 'POST', {}).catch(() => {})
    },
    onError: (error: any, variables: SendMutationInput) => {
      setOptimisticMessages((prev) =>
        prev.map((msg) => (msg.clientTempId === variables.clientTempId ? { ...msg, status: 'FAILED' as const } : msg))
      )
      Alert.alert('Error', error?.message || 'Message failed to send')
    },
  })

  const editMutation = useMutation({
    mutationFn: async ({ messageId, text }: { messageId: string; text: string }) =>
      apiRequest(`/api/messages/conversations/${conversationId}/messages/${messageId}`, 'PATCH', { text }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['mobile-chat-thread', conversationId] }),
        queryClient.invalidateQueries({ queryKey: ['mobile-chat-conversations'] }),
      ])
      setEditingMessage(null)
    },
    onError: (error: any) => {
      Alert.alert('Edit failed', error?.message || 'Unable to edit this message.')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async ({ messageId, mode }: { messageId: string; mode: 'ME' | 'EVERYONE' }) =>
      apiRequest(`/api/messages/conversations/${conversationId}/messages/${messageId}`, 'DELETE', { mode }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['mobile-chat-thread', conversationId] }),
        queryClient.invalidateQueries({ queryKey: ['mobile-chat-conversations'] }),
      ])
    },
    onError: (error: any) => {
      Alert.alert('Delete failed', error?.message || 'Unable to delete this message.')
    },
  })

  const scrollToLatest = useCallback((animated = true) => {
    requestAnimationFrame(() => {
      listRef.current?.scrollToOffset({ offset: 0, animated })
    })
  }, [])

  const closeMessageOptions = useCallback(() => {
    setShowMessageOptions(false)
    setMessageActionTarget(null)
  }, [])

  const openDeleteActions = useCallback(
    (message: ChatMessage | OptimisticMessage) => {
      const isMine = message.senderId === user?.id
      const isOptimistic = 'isOptimistic' in message

      const deleteForMe = () => {
        if (isOptimistic) {
          setOptimisticMessages((prev) => prev.filter((m) => m.id !== message.id))
          return
        }
        deleteMutation.mutate({ messageId: message.id, mode: 'ME' })
      }

      if (isMine && !isOptimistic) {
        Alert.alert('Delete message', 'Choose delete option', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Delete for me', style: 'destructive', onPress: deleteForMe },
          {
            text: 'Delete for everyone',
            style: 'destructive',
            onPress: () => deleteMutation.mutate({ messageId: message.id, mode: 'EVERYONE' }),
          },
        ])
        return
      }

      Alert.alert('Delete message', 'Are you sure you want to delete this message?', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: deleteForMe },
      ])
    },
    [deleteMutation, user?.id]
  )

  const openMessageActions = useCallback((message: ChatMessage | OptimisticMessage) => {
    setMessageActionTarget(message)
    setShowMessageOptions(true)
  }, [])

  const canCopyAction = Boolean(typeof messageActionTarget?.text === 'string' && messageActionTarget.text.trim())
  const canEditAction = Boolean(
    messageActionTarget &&
      messageActionTarget.senderId === user?.id &&
      !('isOptimistic' in messageActionTarget) &&
      !messageActionTarget.attachments?.length &&
      typeof messageActionTarget.text === 'string' &&
      !messageActionTarget.isDeletedForEveryone &&
      !messageActionTarget.deletedForEveryoneAt
  )

  const handleCopyAction = useCallback(() => {
    if (!messageActionTarget || !canCopyAction) return
    void Clipboard.setStringAsync(messageActionTarget.text || '')
    closeMessageOptions()
  }, [canCopyAction, closeMessageOptions, messageActionTarget])

  const handleEditAction = useCallback(() => {
    if (!messageActionTarget || !canEditAction) return
    setReplyTo(null)
    setEditingMessage(messageActionTarget as ChatMessage)
    setText(messageActionTarget.text || '')
    closeMessageOptions()
  }, [canEditAction, closeMessageOptions, messageActionTarget])

  const handleDeleteAction = useCallback(() => {
    if (!messageActionTarget) return
    const target = messageActionTarget
    closeMessageOptions()
    openDeleteActions(target)
  }, [closeMessageOptions, messageActionTarget, openDeleteActions])

  const handleSend = () => {
    if (sendMutation.isPending || editMutation.isPending) return
    if (editingMessage) {
      if (mediaDrafts.length > 0) {
        Alert.alert('Edit message', 'Remove attachments before editing this message.')
        return
      }
      const trimmedEditText = text.trim()
      if (!trimmedEditText) {
        Alert.alert('Edit message', 'Message text cannot be empty.')
        return
      }
      editMutation.mutate({ messageId: editingMessage.id, text: trimmedEditText })
      setText('')
      return
    }
    const { outgoingText, outgoingDrafts, outgoingReplyTo, trimmedText, nextText } = buildSendDraftSnapshot({
      text,
      mediaDrafts,
      replyTo,
    })
    const trimmed = trimmedText
    if (!trimmed && outgoingDrafts.length === 0) return

    const clientTempId = `mobile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const optimisticId = `opt-${clientTempId}`

    const optimistic: OptimisticMessage = {
      id: optimisticId,
      clientTempId,
      senderId: user?.id || '',
      text: trimmed || null,
      type: outgoingDrafts.length > 0 ? 'MEDIA' : 'TEXT',
      status: 'SENT',
      createdAt: new Date().toISOString(),
      attachments: outgoingDrafts
        .filter((m) => m.url)
        .map((m) => ({
          kind: m.kind,
          url: m.url!,
          fileName: m.fileName || null,
          mimeType: m.mimeType || null,
          sizeBytes: m.sizeBytes || null,
          durationMs: m.durationMs || null,
          latitude: m.latitude || null,
          longitude: m.longitude || null,
        })),
      jobId: jobContext?.jobId || null,
      jobNumber: jobContext?.jobNumber || null,
      jobName: jobContext?.jobName || null,
      replyToMessageId: outgoingReplyTo?.id || null,
      replyTo: outgoingReplyTo
        ? {
            messageId: outgoingReplyTo.id,
            senderName:
              `${outgoingReplyTo.sender?.firstName || ''} ${outgoingReplyTo.sender?.lastName || ''}`.trim() ||
              outgoingReplyTo.sender?.email ||
              'Unknown',
            textPreview:
              outgoingReplyTo.text ||
              (outgoingReplyTo.attachments?.[0]?.kind === 'VOICE'
                ? 'Voice note'
                : outgoingReplyTo.attachments?.[0]?.kind === 'IMAGE'
                  ? 'Photo'
                  : outgoingReplyTo.attachments?.[0]?.kind === 'VIDEO'
                    ? 'Video'
                    : outgoingReplyTo.attachments?.[0]?.kind === 'LOCATION'
                      ? 'Location'
                      : outgoingReplyTo.attachments?.[0]?.fileName || ''),
            type: outgoingReplyTo.type,
            createdAt: outgoingReplyTo.createdAt,
          }
        : null,
      isOptimistic: true,
    }

    // Clear composer immediately so text never lingers after tapping send.
    setText(nextText)
    setMediaDrafts([])
    setReplyTo(null)
    setOptimisticMessages((prev) => [...prev, optimistic])
    pendingScrollAfterSendRef.current = true
    sendMutation.mutate({ clientTempId, outgoingText, outgoingDrafts, outgoingReplyTo })
    scrollToLatest(true)
  }

  const pickFromLibrary = async () => {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync()
      if (!permission.granted) {
        Alert.alert('Permission required', 'Please grant access to your photo library.')
        return
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'],
        quality: 0.72,
        allowsMultipleSelection: false,
      })
      if (result.canceled || result.assets.length === 0) return
      const asset = result.assets[0]
      const mimeType =
        asset.mimeType ||
        inferMimeTypeFromName(asset.fileName, asset.type === 'video' ? 'video/mp4' : 'image/jpeg')
      setMediaDrafts((prev) => [
        ...prev,
        {
          kind: mimeType.startsWith('video/') ? 'VIDEO' : 'IMAGE',
          localUri: asset.uri,
          mimeType,
          fileName: ensureFileName(asset.fileName, mimeType, 'chat'),
          sizeBytes: asset.fileSize || undefined,
        },
      ])
    } catch (error: any) {
      Alert.alert('Media error', error?.message || 'Unable to pick media.')
    }
  }

  const pickFromCamera = async () => {
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync()
      if (!permission.granted) {
        Alert.alert('Permission required', 'Please grant camera access.')
        return
      }
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images', 'videos'],
        quality: 0.75,
        videoQuality: ImagePicker.UIImagePickerControllerQualityType.Medium,
      })
      if (result.canceled || result.assets.length === 0) return
      const asset = result.assets[0]
      const mimeType =
        asset.mimeType ||
        inferMimeTypeFromName(asset.fileName, asset.type === 'video' ? 'video/mp4' : 'image/jpeg')
      setMediaDrafts((prev) => [
        ...prev,
        {
          kind: mimeType.startsWith('video/') ? 'VIDEO' : 'IMAGE',
          localUri: asset.uri,
          mimeType,
          fileName: ensureFileName(asset.fileName, mimeType, 'camera'),
          sizeBytes: asset.fileSize || undefined,
        },
      ])
    } catch (error: any) {
      Alert.alert('Camera error', error?.message || 'Unable to open camera.')
    }
  }

  const recordVideoFromCamera = async () => {
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync()
      if (!permission.granted) {
        Alert.alert('Permission required', 'Please grant camera access.')
        return
      }
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['videos'],
        quality: 0.75,
        videoQuality: ImagePicker.UIImagePickerControllerQualityType.Medium,
        videoMaxDuration: 300,
      })
      if (result.canceled || result.assets.length === 0) return
      const asset = result.assets[0]
      const mimeType =
        asset.mimeType ||
        inferMimeTypeFromName(asset.fileName, asset.type === 'video' ? 'video/mp4' : 'image/jpeg')
      setMediaDrafts((prev) => [
        ...prev,
        {
          kind: 'VIDEO',
          localUri: asset.uri,
          mimeType,
          fileName: ensureFileName(asset.fileName, mimeType, 'camera-video'),
          sizeBytes: asset.fileSize || undefined,
        },
      ])
    } catch (error: any) {
      Alert.alert('Video error', error?.message || 'Unable to record video.')
    }
  }

  const runAttachMenuAction = (action: () => Promise<void>) => {
    closeAttachMenu()
    setTimeout(() => {
      void action().catch((error: any) => {
        Alert.alert('Attachment error', error?.message || 'Unable to add attachment.')
      })
    }, 180)
  }

  const pickDocument = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: [
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'text/csv',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'text/plain',
        'image/*',
        'video/*',
        'audio/*',
      ],
      multiple: false,
      copyToCacheDirectory: true,
    })
    if (result.canceled || result.assets.length === 0) return
    const file = result.assets[0]
    const mimeType = inferMimeTypeFromName(file.name, file.mimeType || 'application/octet-stream')
    setMediaDrafts((prev) => [
      ...prev,
      {
        kind: mimeType.startsWith('image/')
          ? 'IMAGE'
          : mimeType.startsWith('video/')
            ? 'VIDEO'
            : 'FILE',
        localUri: file.uri,
        mimeType,
        fileName: ensureFileName(file.name, mimeType, 'file'),
        sizeBytes: file.size || undefined,
      },
    ])
  }

  const pickContact = async () => {
    const permission = await Contacts.requestPermissionsAsync()
    if (!permission.granted) {
      Alert.alert('Permission required', 'Please grant contacts access.')
      return
    }
    const picked = await Contacts.presentContactPickerAsync()
    if (!picked) return
    const phone = picked.phoneNumbers?.[0]?.number || ''
    const email = picked.emails?.[0]?.email || ''
    const name = [picked.firstName, picked.lastName].filter(Boolean).join(' ').trim() || 'Contact'
    const cardLines = [`Contact: ${name}`]
    if (phone) cardLines.push(`Phone: ${phone}`)
    if (email) cardLines.push(`Email: ${email}`)
    setText((prev) => {
      const prefix = prev.trim().length > 0 ? `${prev.trim()}\n` : ''
      return `${prefix}${cardLines.join('\n')}`
    })
  }

  const shareLocation = async () => {
    const permission = await Location.requestForegroundPermissionsAsync()
    if (!permission.granted) {
      Alert.alert('Permission required', 'Location permission is required to share your location.')
      return
    }
    const location = await Location.getCurrentPositionAsync({})
    setMediaDrafts((prev) => [
      ...prev,
      {
        kind: 'LOCATION',
        url: `https://maps.google.com/?q=${location.coords.latitude},${location.coords.longitude}`,
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
      },
    ])
  }

  const openAttachMenu = () => setShowAttachMenu(true)
  const closeAttachMenu = () => setShowAttachMenu(false)

  const MIN_VOICE_DURATION_MS = 450
  const CANCEL_DRAG_THRESHOLD = 56
  const LOCK_DRAG_THRESHOLD = 72

  const clearDurationTicker = () => {
    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current)
      durationIntervalRef.current = null
    }
  }

  const resetRecordingUi = () => {
    clearDurationTicker()
    recordingStartedAtRef.current = null
    pressStartRef.current = null
    recordingLockedRef.current = false
    setRecordingLockedUi(false)
    setRecordingDurationMs(0)
    setRecordingWillCancel(false)
    setIsRecordingUi(false)
  }

  const applyMessageReaction = useCallback((messageId: string, emoji: string) => {
    setMessageReactions((prev) => {
      const cur = { ...(prev[messageId] || {}) }
      cur[emoji] = (cur[emoji] || 0) + 1
      return { ...prev, [messageId]: cur }
    })
  }, [])

  const sendVoiceMessage = async (uri: string, durationMs: number) => {
    if (!token) {
      Alert.alert('Error', 'Authentication required. Please log in again.')
      return
    }

    const voiceFileName = `voice-${Date.now()}.m4a`
    const clientTempId = `mobile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const optimisticId = `opt-${clientTempId}`

    const optimistic: OptimisticMessage = {
      id: optimisticId,
      clientTempId,
      senderId: user?.id || '',
      text: null,
      type: 'MEDIA',
      status: 'SENT',
      createdAt: new Date().toISOString(),
      attachments: [
        {
          kind: 'VOICE',
          url: uri,
          fileName: voiceFileName,
          mimeType: 'audio/m4a',
          sizeBytes: null,
          durationMs,
          latitude: null,
          longitude: null,
        },
      ],
      jobId: jobContext?.jobId || null,
      jobNumber: jobContext?.jobNumber || null,
      jobName: jobContext?.jobName || null,
      replyToMessageId: replyTo?.id || null,
      replyTo: replyTo
        ? {
            messageId: replyTo.id,
            senderName: `${replyTo.sender?.firstName || ''} ${replyTo.sender?.lastName || ''}`.trim() || replyTo.sender?.email || 'Unknown',
            textPreview: replyTo.text || replyTo.attachments?.[0]?.fileName || 'Attachment',
            type: replyTo.type,
            createdAt: replyTo.createdAt,
          }
        : null,
      isOptimistic: true,
    }

    setOptimisticMessages((prev) => [...prev, optimistic])
    pendingScrollAfterSendRef.current = true
    scrollToLatest(true)

    try {
      const payload = await uploadToMessages(uri, 'audio/mp4')
      await apiRequest(`/api/messages/conversations/${conversationId}/messages`, 'POST', {
        text: null,
        jobId: jobContext?.jobId || null,
        clientTempId,
        replyToMessageId: replyTo?.id || null,
        replyToSenderName: replyTo ? `${replyTo.sender?.firstName || ''} ${replyTo.sender?.lastName || ''}`.trim() || replyTo.sender?.email || 'Unknown' : null,
        replyToText: replyTo?.text || replyTo?.attachments?.[0]?.fileName || 'Attachment',
        replyToType: replyTo?.type || null,
        attachments: [
          {
            kind: 'VOICE',
            url: payload.url,
            fileName: voiceFileName,
            mimeType: 'audio/m4a',
            sizeBytes: null,
            durationMs,
            latitude: null,
            longitude: null,
          },
        ],
      })

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['mobile-chat-thread', conversationId] }),
        queryClient.invalidateQueries({ queryKey: ['mobile-chat-conversations'] }),
      ])
      setReplyTo(null)
      apiRequest(`/api/messages/conversations/${conversationId}/read`, 'POST', {}).catch(() => {})
    } catch (error: any) {
      console.error('Voice send failed', error, error?.stack)
      setOptimisticMessages((prev) =>
        prev.map((msg) => (msg.clientTempId === clientTempId ? { ...msg, status: 'FAILED' as const } : msg))
      )
      Alert.alert('Upload error', error?.message || 'Failed to send voice note.')
    }
  }

  const startRecording = async (event: GestureResponderEvent) => {
    const recorder = voiceRecorderRef.current
    const sessionId = Date.now()
    pressSessionRef.current = sessionId
    pressStartRef.current = { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY }
    setRecordingWillCancel(false)
    setRecordingDurationMs(0)
    setIsRecordingUi(true)

    try {
      await recorder.start()

      if (pressSessionRef.current !== sessionId) {
        // Press ended before startup completed.
        await recorder.cancel()
        resetRecordingUi()
        return
      }

      recordingStartedAtRef.current = Date.now()
      setIsRecordingUi(true)
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {})
      clearDurationTicker()
      durationIntervalRef.current = setInterval(() => {
        if (!recordingStartedAtRef.current) return
        setRecordingDurationMs(Date.now() - recordingStartedAtRef.current)
      }, 150)
    } catch (error: any) {
      await recorder.forceCleanup()
      resetRecordingUi()
      Alert.alert('Recording error', error?.message || 'Unable to start voice recording.')
    }
  }

  const moveRecording = (event: GestureResponderEvent) => {
    if (!pressStartRef.current) return
    const dx = event.nativeEvent.pageX - pressStartRef.current.x
    const dy = event.nativeEvent.pageY - pressStartRef.current.y
    if (
      !recordingLockedRef.current &&
      voiceRecorderRef.current.isRecording() &&
      dy < -LOCK_DRAG_THRESHOLD
    ) {
      recordingLockedRef.current = true
      setRecordingLockedUi(true)
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {})
    }
    const shouldCancel = dx < -CANCEL_DRAG_THRESHOLD && !recordingLockedRef.current
    if (shouldCancel !== recordingWillCancel) {
      setRecordingWillCancel(shouldCancel)
    }
  }

  const cancelRecording = async () => {
    pressSessionRef.current = 0
    const recorder = voiceRecorderRef.current
    try {
      if (recorder.isRecording() || recorder.getPhase() === 'starting') {
        await recorder.cancel()
      }
    } catch {
    } finally {
      resetRecordingUi()
    }
  }

  const stopRecording = async (event: GestureResponderEvent) => {
    if (recordingLockedRef.current) {
      return
    }
    if (stopInFlightRef.current) return
    stopInFlightRef.current = true
    const recorder = voiceRecorderRef.current
    pressSessionRef.current = 0

    // Start never completed; nothing to stop, ensure cleanup and exit.
    if (!recorder.isRecording()) {
      resetRecordingUi()
      stopInFlightRef.current = false
      return
    }

    const elapsed = recordingStartedAtRef.current ? Date.now() - recordingStartedAtRef.current : 0
    // Some Android devices can emit an early synthetic release while still holding.
    // Ignore very short non-cancel releases so hold-to-record remains stable.
    if (!recordingWillCancel && elapsed < MIN_VOICE_DURATION_MS) {
      stopInFlightRef.current = false
      return
    }
    const dragDx = pressStartRef.current ? event.nativeEvent.pageX - pressStartRef.current.x : 0
    const shouldCancel = recordingWillCancel || dragDx < -CANCEL_DRAG_THRESHOLD
    if (shouldCancel) {
      await cancelRecording()
      stopInFlightRef.current = false
      return
    }

    try {
      const result = await recorder.stop()
      resetRecordingUi()
      await sendVoiceMessage(result.uri, result.durationMs)
    } catch (error: any) {
      await recorder.forceCleanup()
      resetRecordingUi()
      Alert.alert('Error', error?.message || 'Failed to stop recording.')
    } finally {
      stopInFlightRef.current = false
    }
  }

  const sendLockedVoiceRecording = async () => {
    if (stopInFlightRef.current) return
    stopInFlightRef.current = true
    pressSessionRef.current = 0
    recordingLockedRef.current = false
    setRecordingLockedUi(false)
    const recorder = voiceRecorderRef.current
    try {
      if (!recorder.isRecording()) {
        resetRecordingUi()
        return
      }
      const result = await recorder.stop()
      resetRecordingUi()
      await sendVoiceMessage(result.uri, result.durationMs)
    } catch (error: any) {
      await recorder.forceCleanup()
      resetRecordingUi()
      Alert.alert('Error', error?.message || 'Failed to stop recording.')
    } finally {
      stopInFlightRef.current = false
    }
  }

  const discardLockedVoiceRecording = async () => {
    await cancelRecording()
  }

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      // Android can emit transient inactive/pause events during touch interactions.
      // Only force-cancel when app truly goes to background.
      if (state === 'background' && voiceRecorderRef.current.isRecording()) {
        cancelRecording().catch(() => {})
      }
    })
    return () => {
      sub.remove()
      if (voiceRecorderRef.current.isRecording() || voiceRecorderRef.current.getPhase() === 'starting') {
        cancelRecording().catch(() => {})
      }
      clearDurationTicker()
    }
  }, [])

  const messages = useMemo(() => {
    const server = threadQuery.data?.messages || []
    const all = [...server, ...optimisticMessages]
    return all.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  }, [threadQuery.data?.messages, optimisticMessages])

  const messagesWithDates = useMemo(() => {
    const result: Array<ChatMessage | OptimisticMessage | { type: 'DATE'; date: Date }> = []
    let lastDate: Date | null = null
    for (const msg of messages) {
      const msgDate = new Date(msg.createdAt)
      const dateOnly = new Date(msgDate.getFullYear(), msgDate.getMonth(), msgDate.getDate())
      if (!lastDate || dateOnly.getTime() !== lastDate.getTime()) {
        result.push({ type: 'DATE', date: dateOnly })
        lastDate = dateOnly
      }
      result.push(msg)
    }
    return result
  }, [messages])
  useEffect(() => {
    if (!pendingScrollAfterSendRef.current) return
    pendingScrollAfterSendRef.current = false
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        listRef.current?.scrollToOffset({ offset: 0, animated: true })
      })
    })
  }, [messages.length])

  const renderItems = useMemo(() => toInvertedThreadItems(messagesWithDates), [messagesWithDates])
  const messageIndexMap = useMemo(() => {
    const map = new Map<string, number>()
    renderItems.forEach((item, index) => {
      if ('type' in item && item.type === 'DATE') return
      if ('id' in item) {
        map.set(String(item.id), index)
      }
    })
    return map
  }, [renderItems])

  const conversation = conversationQuery.data?.conversation
  const listedConversation = conversationsQuery.data?.conversations?.find((item) => item.id === conversationId)
  const conversationType = listedConversation?.type || conversation?.type
  const jobConversation = conversationType === 'JOB_THREAD' ? (listedConversation || conversation) : null
  const siblingJobThreads = useMemo(
    () =>
      jobConversation?.jobId
        ? (conversationsQuery.data?.conversations || []).filter(
            (item) => item.type === 'JOB_THREAD' && item.jobId === jobConversation.jobId
          )
        : [],
    [conversationsQuery.data?.conversations, jobConversation?.jobId]
  )
  const isGroupChat = conversationType === 'TEAM' || conversationType === 'JOB_THREAD'
  const threadTitle = useMemo(() => {
    const normalizeTitle = (value?: string | null) => value?.trim() || ''
    const isPlaceholderTitle = (value: string) =>
      ['conversation', 'direct message', 'dm', 'message'].includes(value.toLowerCase())

    if (conversationType === 'TEAM') {
      const teamTitle = normalizeTitle(listedConversation?.title) || normalizeTitle(conversation?.title)
      return teamTitle || 'Team Chat'
    }

    if (conversationType === 'JOB_THREAD') {
      const jobTitle =
        normalizeTitle(listedConversation?.threadTitle) ||
        normalizeTitle(conversation?.threadTitle) ||
        normalizeTitle(listedConversation?.title) ||
        normalizeTitle(conversation?.title)
      if (jobTitle && !isPlaceholderTitle(jobTitle)) return jobTitle
      return 'Job Thread'
    }

    const otherUser = listedConversation?.otherUser
    if (otherUser) {
      const fullName = `${otherUser.firstName || ''} ${otherUser.lastName || ''}`.trim()
      if (fullName) return fullName
      if (otherUser.email) return otherUser.email
    }

    const preferredTitle = normalizeTitle(listedConversation?.title) || normalizeTitle(conversation?.title)
    if (preferredTitle && !isPlaceholderTitle(preferredTitle)) return preferredTitle

    return 'Direct Message'
  }, [listedConversation, conversation, conversationType])
  const otherUserAvatar = listedConversation?.otherUser?.avatar || null

  const threadColumn = (
    <View style={styles.mainColumn}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color={colors.textPrimary} />
        </Pressable>
        {isGroupChat ? (
          <View style={styles.teamAvatarCircle}>
            <Text style={styles.teamAvatarLetter}>{threadTitle.slice(0, 1).toUpperCase()}</Text>
          </View>
        ) : otherUserAvatar ? (
          <Image source={{ uri: otherUserAvatar }} style={styles.headerAvatar} />
        ) : (
          <View style={styles.directAvatarCircle}>
            <Text style={styles.teamAvatarLetter}>{threadTitle.slice(0, 1).toUpperCase()}</Text>
          </View>
        )}
        <View style={styles.headerContent}>
          <Text style={styles.headerTitle}>{threadTitle}</Text>
          {isGroupChat ? (
            <Text style={styles.headerSubtitle}>
              {conversationType === 'JOB_THREAD'
                ? [
                    jobConversation?.jobNumber ? `Job ${jobConversation.jobNumber}` : 'Job chat',
                    jobConversation?.jobTitle,
                  ].filter(Boolean).join(' — ')
                : 'Group'}
            </Text>
          ) : null}
        </View>
      </View>

      {jobConversation?.jobId ? (
        <View style={styles.threadSwitcher}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.threadSwitcherContent}>
            {siblingJobThreads.map((thread) => {
              const active = thread.id === conversationId
              return (
                <Pressable
                  key={thread.id}
                  style={[styles.threadChip, active && styles.threadChipActive]}
                  disabled={active || switchJobThreadMutation.isPending}
                  onPress={() =>
                    switchJobThreadMutation.mutate({
                      jobId: jobConversation.jobId!,
                      targetConversationId: thread.id,
                    })
                  }
                >
                  <Text style={[styles.threadChipText, active && styles.threadChipTextActive]}>
                    {thread.threadTitle || thread.title || 'General'}
                  </Text>
                </Pressable>
              )
            })}
            <Pressable style={styles.newThreadChip} onPress={() => setShowNewThreadModal(true)}>
              <Ionicons name="add" size={15} color={colors.brandPrimary} />
              <Text style={styles.newThreadChipText}>New thread</Text>
            </Pressable>
          </ScrollView>
        </View>
      ) : null}

      <FlatList
          ref={listRef}
          style={styles.threadList}
          data={renderItems}
          keyExtractor={(item, index) => {
            if ('type' in item && item.type === 'DATE') {
              return `date-${item.date.toISOString()}`
            }
            return 'id' in item ? item.id : `opt-${index}`
          }}
          contentContainerStyle={[styles.listContent, { paddingTop: spacing.sm }]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          inverted
          showsVerticalScrollIndicator={false}
          renderItem={({ item }) => {
            if ('type' in item && item.type === 'DATE') {
              return <DateSeparator date={item.date} />
            }
            try {
            const message = item as ChatMessage | OptimisticMessage
            const isMine = message.senderId === user?.id
            const resolvedReplyTo = message.replyTo || replyFallbackByMessageId[message.id]
            return (
              <MessageBubble
                message={{ ...(message as ChatMessage), replyTo: resolvedReplyTo } as ChatMessage}
                isMine={isMine}
                showSender={isGroupChat && !isMine}
                reactionCounts={messageReactions[String(message.id)]}
                onReaction={(emoji) => applyMessageReaction(String(message.id), emoji)}
                onSwipeReply={(swipedMessage) => {
                  setEditingMessage(null)
                  setReplyTo(swipedMessage)
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {})
                }}
                onReplyPress={(messageId) => {
                  const targetIndex = messageIndexMap.get(messageId)
                  if (typeof targetIndex === 'number') {
                    listRef.current?.scrollToIndex({ index: targetIndex, animated: true, viewPosition: 0.2 })
                  }
                }}
                onJobPress={(jobId) => Linking.openURL(`trimpro://jobs/${jobId}`)}
                onImagePress={(uri, fileName) => {
                  // uri is the resolved absolute URL; attachment.url may still be relative
                  const attachment = message.attachments?.find((a: any) => {
                    if (!a.url) return false
                    if (a.url === uri) return true
                    const resolved = a.url.startsWith('/') ? `${API_BASE_URL}${a.url}` : a.url
                    return resolved === uri
                  })
                  // Determine kind: use attachment data or fall back to extension detection
                  const kind: 'IMAGE' | 'VIDEO' =
                    attachment?.kind === 'VIDEO' || /\.(mp4|mov|avi|mkv|webm|m4v)$/i.test(uri)
                      ? 'VIDEO'
                      : 'IMAGE'
                  setViewingMedia({ uri, fileName, kind })
                }}
                onLongPress={() => openMessageActions(message)}
              />
            )
            } catch (e) {
              console.error('[renderItem crash]', e)
              return null
            }
          }}
        />

      <View
        onLayout={(e) => {
          const h = Math.round(e.nativeEvent.layout.height)
          if (h < 1) return
          if (composerDockLayoutRafRef.current != null) {
            cancelAnimationFrame(composerDockLayoutRafRef.current)
          }
          composerDockLayoutRafRef.current = requestAnimationFrame(() => {
            composerDockLayoutRafRef.current = null
            setComposerDockHeight((prev) => (Math.abs(prev - h) > 1 ? h : prev))
          })
        }}
      >
          {editingMessage ? (
            <View style={styles.editingBar}>
              <View style={styles.editingBarTextWrap}>
                <Text style={styles.editingLabel}>Editing message</Text>
                <Text numberOfLines={1} style={styles.editingPreview}>
                  {editingMessage.text || ''}
                </Text>
              </View>
              <Pressable
                style={styles.editingCancelButton}
                onPress={() => {
                  setEditingMessage(null)
                  setText('')
                }}
              >
                <Text style={styles.editingCancelText}>Cancel</Text>
              </Pressable>
            </View>
          ) : null}

          <View style={styles.composerDock}>
            <Composer
              text={text}
              onChangeText={setText}
              onSend={handleSend}
              onOpenMenu={openAttachMenu}
              onOpenCamera={() => {
                void pickFromCamera()
              }}
              onVoiceStart={startRecording}
              onVoiceMove={moveRecording}
              onVoiceStop={stopRecording}
              onVoiceCancel={cancelRecording}
              voiceLocked={recordingLockedUi}
              onVoiceSendLocked={sendLockedVoiceRecording}
              onVoiceDiscardLocked={discardLockedVoiceRecording}
              attachments={mediaDrafts}
              onRemoveAttachment={(index) => setMediaDrafts((prev) => prev.filter((_, i) => i !== index))}
              recording={isRecordingUi}
              recordingDurationMs={recordingDurationMs}
              recordingWillCancel={recordingWillCancel && !recordingLockedUi}
              replyPreview={
                replyTo
                  ? {
                      senderName: `${replyTo.sender?.firstName || ''} ${replyTo.sender?.lastName || ''}`.trim() || replyTo.sender?.email || 'Unknown',
                      textPreview: replyTo.text || replyTo.attachments?.[0]?.fileName || replyTo.attachments?.[0]?.kind || '',
                    }
                  : null
              }
              onClearReply={() => setReplyTo(null)}
              sending={sendMutation.isPending}
              disabled={!isOnline}
              bottomInset={0}
            />
          </View>
      </View>
    </View>
  )

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView style={styles.fill} behavior="padding" keyboardVerticalOffset={0}>
        {threadColumn}
      </KeyboardAvoidingView>

      {viewingMedia && (
        <MediaViewer
          visible={!!viewingMedia}
          uri={viewingMedia.uri}
          fileName={viewingMedia.fileName}
          kind={viewingMedia.kind}
          onClose={() => setViewingMedia(null)}
        />
      )}
      <ReactNativeModal
        isVisible={showMessageOptions}
        onBackdropPress={closeMessageOptions}
        onBackButtonPress={closeMessageOptions}
        animationIn="slideInUp"
        animationOut="slideOutDown"
        backdropOpacity={0.35}
        style={styles.messageOptionsModal}
        useNativeDriver
        hideModalContentWhileAnimating
      >
        <View style={styles.messageOptionsSheet}>
          <Text style={styles.messageOptionsTitle}>Message Options</Text>
          <Pressable
            style={({ pressed }) => [styles.messageActionRow, pressed && styles.messageActionRowPressed, !canCopyAction && styles.messageActionRowDisabled]}
            onPress={handleCopyAction}
            disabled={!canCopyAction}
            android_ripple={{ color: 'rgba(0,0,0,0.06)' }}
          >
            <Ionicons name="copy-outline" size={20} color="#222222" style={styles.messageActionIcon} />
            <Text style={styles.messageActionText}>Copy</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.messageActionRow, pressed && styles.messageActionRowPressed, !canEditAction && styles.messageActionRowDisabled]}
            onPress={handleEditAction}
            disabled={!canEditAction}
            android_ripple={{ color: 'rgba(0,0,0,0.06)' }}
          >
            <Ionicons name="create-outline" size={20} color="#222222" style={styles.messageActionIcon} />
            <Text style={styles.messageActionText}>Edit</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.messageActionRow, pressed && styles.messageActionRowPressed]}
            onPress={handleDeleteAction}
            android_ripple={{ color: 'rgba(229,57,53,0.1)' }}
          >
            <Ionicons name="trash-outline" size={20} color="#E53935" style={styles.messageActionIcon} />
            <Text style={styles.messageActionTextDelete}>Delete</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.messageActionCancelRow, pressed && styles.messageActionRowPressed]}
            onPress={closeMessageOptions}
            android_ripple={{ color: 'rgba(0,0,0,0.06)' }}
          >
            <Text style={styles.messageActionText}>Cancel</Text>
          </Pressable>
        </View>
      </ReactNativeModal>
      <RNModal visible={showAttachMenu} transparent animationType="slide" onRequestClose={closeAttachMenu}>
        <Pressable style={styles.menuBackdrop} onPress={closeAttachMenu}>
          <Pressable style={styles.menuSheet} onPress={(event) => event.stopPropagation()}>
            <Text style={styles.menuTitle}>Share</Text>
            <ScrollView>
              <Pressable style={styles.menuItem} onPress={() => runAttachMenuAction(pickFromCamera)}>
                <Ionicons name="camera-outline" size={18} color={colors.textPrimary} />
                <Text style={styles.menuItemText}>Camera</Text>
              </Pressable>
              <Pressable style={styles.menuItem} onPress={() => runAttachMenuAction(recordVideoFromCamera)}>
                <Ionicons name="videocam-outline" size={18} color={colors.textPrimary} />
                <Text style={styles.menuItemText}>Record Video</Text>
              </Pressable>
              <Pressable style={styles.menuItem} onPress={() => runAttachMenuAction(pickFromLibrary)}>
                <Ionicons name="images-outline" size={18} color={colors.textPrimary} />
                <Text style={styles.menuItemText}>Photo & Video Library</Text>
              </Pressable>
              <Pressable style={styles.menuItem} onPress={() => runAttachMenuAction(pickDocument)}>
                <Ionicons name="document-outline" size={18} color={colors.textPrimary} />
                <Text style={styles.menuItemText}>Document</Text>
              </Pressable>
              <Pressable style={styles.menuItem} onPress={() => runAttachMenuAction(pickContact)}>
                <Ionicons name="person-outline" size={18} color={colors.textPrimary} />
                <Text style={styles.menuItemText}>Contact</Text>
              </Pressable>
              <Pressable style={styles.menuItem} onPress={() => runAttachMenuAction(shareLocation)}>
                <Ionicons name="location-outline" size={18} color={colors.textPrimary} />
                <Text style={styles.menuItemText}>Location</Text>
              </Pressable>
            </ScrollView>
          </Pressable>
        </Pressable>
      </RNModal>
      <RNModal
        visible={showNewThreadModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowNewThreadModal(false)}
      >
        <Pressable style={styles.threadModalBackdrop} onPress={() => setShowNewThreadModal(false)}>
          <Pressable style={styles.threadModalCard} onPress={(event) => event.stopPropagation()}>
            <Text style={styles.threadModalTitle}>New job thread</Text>
            <TextInput
              value={newThreadTitle}
              onChangeText={setNewThreadTitle}
              placeholder="e.g. Materials or Punch list"
              autoFocus
              style={styles.threadModalInput}
              returnKeyType="done"
              onSubmitEditing={() => {
                const title = newThreadTitle.trim()
                if (title && jobConversation?.jobId) {
                  switchJobThreadMutation.mutate({ jobId: jobConversation.jobId, title })
                }
              }}
            />
            <View style={styles.threadModalActions}>
              <Pressable style={styles.threadModalCancel} onPress={() => setShowNewThreadModal(false)}>
                <Text style={styles.threadModalCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.threadModalCreate, !newThreadTitle.trim() && styles.threadModalCreateDisabled]}
                disabled={!newThreadTitle.trim() || switchJobThreadMutation.isPending}
                onPress={() => {
                  if (jobConversation?.jobId) {
                    switchJobThreadMutation.mutate({ jobId: jobConversation.jobId, title: newThreadTitle.trim() })
                  }
                }}
              >
                <Text style={styles.threadModalCreateText}>Create</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </RNModal>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#EFEAE2',
  },
  fill: {
    flex: 1,
    minHeight: 0,
  },
  mainColumn: {
    flex: 1,
    minHeight: 0,
  },
  threadList: {
    flex: 1,
    minHeight: 0,
    backgroundColor: '#EFEAE2',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.08)',
    backgroundColor: colors.surface,
  },
  backButton: {
    padding: spacing.xs,
    marginRight: spacing.xs,
  },
  headerAvatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    marginRight: spacing.xs,
  },
  teamAvatarCircle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#00A884',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.xs,
  },
  teamAvatarLetter: {
    color: colors.surface,
    fontSize: 15,
    fontWeight: '700',
  },
  directAvatarCircle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#00A884',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.xs,
  },
  headerContent: {
    flex: 1,
    justifyContent: 'center',
  },
  headerTitle: {
    ...typography.sub,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  headerSubtitle: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: 1,
  },
  threadSwitcher: {
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  threadSwitcherContent: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    gap: spacing.xs,
  },
  threadChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.divider,
    backgroundColor: colors.surface,
  },
  threadChipActive: {
    borderColor: '#25D366',
    backgroundColor: '#D9FDD3',
  },
  threadChipText: {
    ...typography.caption,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  threadChipTextActive: {
    color: '#075E54',
  },
  newThreadChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.brandPrimary + '55',
    backgroundColor: colors.surface,
  },
  newThreadChipText: {
    ...typography.caption,
    color: colors.brandPrimary,
    fontWeight: '700',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  headerIconButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  listContent: {
    paddingBottom: 4,
  },
  composerDock: {
    backgroundColor: '#F0F2F5',
  },
  editingBar: {
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  editingBarTextWrap: {
    flex: 1,
  },
  editingLabel: {
    ...typography.caption,
    color: colors.brandPrimary,
    fontWeight: '700',
  },
  editingPreview: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: 2,
  },
  editingCancelButton: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: '#EEF2F7',
  },
  editingCancelText: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  menuBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'flex-end',
  },
  threadModalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  threadModalCard: {
    width: '100%',
    maxWidth: 420,
    borderRadius: 16,
    backgroundColor: colors.surface,
    padding: spacing.md,
  },
  threadModalTitle: {
    ...typography.sub,
    color: colors.textPrimary,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  threadModalInput: {
    ...typography.body,
    color: colors.textPrimary,
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  threadModalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  threadModalCancel: {
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  threadModalCancelText: {
    ...typography.body,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  threadModalCreate: {
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 9,
    backgroundColor: colors.brandPrimary,
  },
  threadModalCreateDisabled: {
    opacity: 0.45,
  },
  threadModalCreateText: {
    ...typography.body,
    color: colors.surface,
    fontWeight: '700',
  },
  messageOptionsModal: {
    justifyContent: 'flex-end',
    margin: 0,
  },
  messageOptionsSheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
  },
  messageOptionsTitle: {
    ...typography.sub,
    color: '#222222',
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  messageActionRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
    borderRadius: 12,
  },
  messageActionRowPressed: {
    backgroundColor: 'rgba(0,0,0,0.05)',
  },
  messageActionRowDisabled: {
    opacity: 0.45,
  },
  messageActionIcon: {
    marginRight: 12,
  },
  messageActionText: {
    ...typography.body,
    color: '#222222',
  },
  messageActionTextDelete: {
    ...typography.body,
    color: '#E53935',
  },
  messageActionCancelRow: {
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E7E7E7',
    marginTop: spacing.xs,
    borderRadius: 12,
  },
  menuSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
    maxHeight: '70%',
  },
  menuTitle: {
    ...typography.sub,
    color: colors.textPrimary,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 13,
  },
  menuItemText: {
    ...typography.body,
    color: colors.textPrimary,
  },
})
