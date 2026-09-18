import AsyncStorage from '@react-native-async-storage/async-storage'
import * as FileSystem from 'expo-file-system/legacy'
import { API_BASE_URL } from '../config/env'

const OUTBOX_KEY = 'trimpro.mobile.outbox'

export type OutboxAction =
  | { id: string; type: 'job-status'; payload: { jobId: string; status: string; notes?: string } }
  | { id: string; type: 'job-note'; payload: { jobId: string; content: string } }
  | { id: string; type: 'time-start'; payload: { jobId: string; startedAt?: string; note?: string } }
  | { id: string; type: 'time-stop'; payload: { jobId: string; endedAt?: string; note?: string } }
  | {
      id: string
      type: 'time-manual'
      payload: { jobId: string; durationMinutes: number; note?: string; startedAt?: string; endedAt?: string }
    }
  | { id: string; type: 'task-status'; payload: { taskId: string; status: string } }
  | { id: string; type: 'issue-status'; payload: { issueId: string; status: string } }
  | {
      id: string
      type: 'message-send'
      payload: {
        conversationId: string
        to: string
        from: string
        body: string
        channel: string
        media?: Array<{ type: string; url: string; mimeType?: string; size?: number; filename?: string }>
      }
    }
  | {
      id: string
      type: 'message-send-with-upload'
      payload: {
        conversationId: string
        to: string
        from: string
        body: string
        channel: string
        mediaFiles: Array<{
          type: string
          uri: string
          mimeType: string
          fileName: string
          fileSize: number
        }>
      }
    }
  | {
      id: string
      type: 'team-chat-send'
      payload: {
        body: string
        mentions?: string[]
        media?: Array<{ type: string; url: string; mimeType?: string; size?: number; filename?: string }>
      }
    }
  | {
      id: string
      type: 'team-chat-send-with-upload'
      payload: {
        body: string
        mentions?: string[]
        mediaFiles: Array<{
          type: string
          uri: string
          mimeType: string
          fileName: string
          fileSize: number
        }>
      }
    }
  | {
      id: string
      type: 'job-media'
      payload: {
        jobId: string
        uri: string
        mimeType: string
        fileName: string
        fileSize: number
      }
    }
  | {
      id: string
      type: 'entity-media'
      payload: {
        entityType: 'job' | 'task' | 'issue'
        entityId: string
        uri: string
        mimeType: string
        fileName: string
        fileSize: number
      }
    }

export async function loadOutbox(): Promise<OutboxAction[]> {
  const raw = await AsyncStorage.getItem(OUTBOX_KEY)
  if (!raw) return []
  try {
    return JSON.parse(raw) as OutboxAction[]
  } catch {
    return []
  }
}

export async function saveOutbox(items: OutboxAction[]) {
  await AsyncStorage.setItem(OUTBOX_KEY, JSON.stringify(items))
}

export async function enqueueOutbox(action: OutboxAction) {
  const items = await loadOutbox()
  items.push(action)
  await saveOutbox(items)
}

export async function removeOutboxAction(id: string) {
  const items = await loadOutbox()
  const next = items.filter((item) => item.id !== id)
  await saveOutbox(next)
}

export async function clearOutbox() {
  await saveOutbox([])
}

export async function getOutboxCount() {
  const items = await loadOutbox()
  return items.length
}

async function authorizedHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  }
}

export async function flushOutbox(token: string) {
  const queue = await loadOutbox()
  if (queue.length === 0) return { remaining: 0, processed: 0 }

  const remaining: OutboxAction[] = []
  let processed = 0

  for (const action of queue) {
    try {
      if (action.type === 'job-status') {
        const response = await fetch(`${API_BASE_URL}/api/mobile/jobs/${action.payload.jobId}/status`, {
          method: 'POST',
          headers: {
            ...(await authorizedHeaders(token)),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            status: action.payload.status,
            notes: action.payload.notes || null,
          }),
        })
        if (!response.ok) throw new Error('Job status sync failed')
      } else if (action.type === 'job-note') {
        const response = await fetch(`${API_BASE_URL}/api/mobile/jobs/${action.payload.jobId}/note`, {
          method: 'POST',
          headers: {
            ...(await authorizedHeaders(token)),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ content: action.payload.content }),
        })
        if (!response.ok) throw new Error('Job note sync failed')
      } else if (action.type === 'time-start') {
        const response = await fetch(`${API_BASE_URL}/api/jobs/${action.payload.jobId}/time/start`, {
          method: 'POST',
          headers: {
            ...(await authorizedHeaders(token)),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            startedAt: action.payload.startedAt || undefined,
            note: action.payload.note || undefined,
          }),
        })
        if (!response.ok) throw new Error('Time start sync failed')
      } else if (action.type === 'time-stop') {
        const response = await fetch(`${API_BASE_URL}/api/jobs/${action.payload.jobId}/time/stop`, {
          method: 'POST',
          headers: {
            ...(await authorizedHeaders(token)),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            endedAt: action.payload.endedAt || undefined,
            note: action.payload.note || undefined,
          }),
        })
        if (!response.ok) throw new Error('Time stop sync failed')
      } else if (action.type === 'time-manual') {
        const response = await fetch(`${API_BASE_URL}/api/jobs/${action.payload.jobId}/time/manual`, {
          method: 'POST',
          headers: {
            ...(await authorizedHeaders(token)),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            durationMinutes: action.payload.durationMinutes,
            note: action.payload.note || undefined,
            startedAt: action.payload.startedAt || undefined,
            endedAt: action.payload.endedAt || undefined,
          }),
        })
        if (!response.ok) throw new Error('Manual time sync failed')
      } else if (action.type === 'task-status') {
        const response = await fetch(`${API_BASE_URL}/api/tasks/${action.payload.taskId}`, {
          method: 'PUT',
          headers: {
            ...(await authorizedHeaders(token)),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ status: action.payload.status }),
        })
        if (!response.ok) throw new Error('Task status sync failed')
      } else if (action.type === 'issue-status') {
        const response = await fetch(`${API_BASE_URL}/api/issues/${action.payload.issueId}`, {
          method: 'PUT',
          headers: {
            ...(await authorizedHeaders(token)),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ status: action.payload.status }),
        })
        if (!response.ok) throw new Error('Issue status sync failed')
      } else if (action.type === 'message-send') {
        const response = await fetch(`${API_BASE_URL}/api/messages/conversations/${action.payload.conversationId}/messages`, {
          method: 'POST',
          headers: {
            ...(await authorizedHeaders(token)),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text: action.payload.body,
            attachments: (action.payload.media || []).map((media) => ({
              kind:
                String(media.type || '').toLowerCase() === 'image'
                  ? 'IMAGE'
                  : String(media.type || '').toLowerCase() === 'video'
                    ? 'VIDEO'
                    : String(media.type || '').toLowerCase() === 'voice'
                      ? 'VOICE'
                      : 'FILE',
              url: media.url,
              mimeType: media.mimeType,
              sizeBytes: media.size,
              fileName: media.filename,
            })),
            clientTempId: `outbox-${action.id}`,
          }),
        })
        if (!response.ok) throw new Error('Message sync failed')
      } else if (action.type === 'message-send-with-upload') {
        const media: Array<{ type: string; url: string; mimeType?: string; size?: number; filename?: string }> = []
        for (const mediaFile of action.payload.mediaFiles) {
          const uploadResult = await FileSystem.uploadAsync(`${API_BASE_URL}/api/uploads`, mediaFile.uri, {
            fieldName: 'file',
            httpMethod: 'POST',
            uploadType: FileSystem.FileSystemUploadType.MULTIPART,
            headers: await authorizedHeaders(token),
            mimeType: mediaFile.mimeType,
          })

          if (uploadResult.status < 200 || uploadResult.status >= 300) {
            throw new Error('Message media upload failed while syncing outbox')
          }

          const uploadPayload = JSON.parse(uploadResult.body)
          media.push({
            type: mediaFile.type,
            url: uploadPayload.url,
            mimeType: mediaFile.mimeType,
            size: mediaFile.fileSize,
            filename: mediaFile.fileName,
          })
        }

        const response = await fetch(`${API_BASE_URL}/api/messages/conversations/${action.payload.conversationId}/messages`, {
          method: 'POST',
          headers: {
            ...(await authorizedHeaders(token)),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text: action.payload.body,
            attachments: media.map((m) => ({
              kind:
                String(m.type || '').toLowerCase() === 'image'
                  ? 'IMAGE'
                  : String(m.type || '').toLowerCase() === 'video'
                    ? 'VIDEO'
                    : String(m.type || '').toLowerCase() === 'voice'
                      ? 'VOICE'
                      : 'FILE',
              url: m.url,
              mimeType: m.mimeType,
              sizeBytes: m.size,
              fileName: m.filename,
            })),
            clientTempId: `outbox-upload-${action.id}`,
          }),
        })
        if (!response.ok) throw new Error('Message send failed after media upload')
      } else if (action.type === 'team-chat-send') {
        const response = await fetch(`${API_BASE_URL}/api/mobile/team-chat`, {
          method: 'POST',
          headers: {
            ...(await authorizedHeaders(token)),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            body: action.payload.body,
            mentions: action.payload.mentions || [],
            media: action.payload.media || [],
          }),
        })
        if (!response.ok) throw new Error('Team chat sync failed')
      } else if (action.type === 'team-chat-send-with-upload') {
        const media: Array<{ type: string; url: string; mimeType?: string; size?: number; filename?: string }> = []
        for (const mediaFile of action.payload.mediaFiles) {
          const uploadResult = await FileSystem.uploadAsync(`${API_BASE_URL}/api/uploads`, mediaFile.uri, {
            fieldName: 'file',
            httpMethod: 'POST',
            uploadType: FileSystem.FileSystemUploadType.MULTIPART,
            headers: await authorizedHeaders(token),
            mimeType: mediaFile.mimeType,
          })

          if (uploadResult.status < 200 || uploadResult.status >= 300) {
            throw new Error('Team chat media upload failed while syncing outbox')
          }

          const uploadPayload = JSON.parse(uploadResult.body)
          media.push({
            type: mediaFile.type,
            url: uploadPayload.url,
            mimeType: mediaFile.mimeType,
            size: mediaFile.fileSize,
            filename: mediaFile.fileName,
          })
        }

        const response = await fetch(`${API_BASE_URL}/api/mobile/team-chat`, {
          method: 'POST',
          headers: {
            ...(await authorizedHeaders(token)),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            body: action.payload.body,
            mentions: action.payload.mentions || [],
            media,
          }),
        })
        if (!response.ok) throw new Error('Team chat send failed after media upload')
      } else {
        const entityType = action.type === 'job-media' ? 'job' : action.payload.entityType
        const entityId = action.type === 'job-media' ? action.payload.jobId : action.payload.entityId
        const uploadResult = await FileSystem.uploadAsync(`${API_BASE_URL}/api/uploads`, action.payload.uri, {
          fieldName: 'file',
          httpMethod: 'POST',
          uploadType: FileSystem.FileSystemUploadType.MULTIPART,
          headers: await authorizedHeaders(token),
          mimeType: action.payload.mimeType,
        })

        if (uploadResult.status < 200 || uploadResult.status >= 300) {
          throw new Error('Upload failed while syncing outbox')
        }

        const uploadPayload = JSON.parse(uploadResult.body)
        const attachmentResponse = await fetch(`${API_BASE_URL}/api/attachments`, {
          method: 'POST',
          headers: {
            ...(await authorizedHeaders(token)),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            entityType,
            entityId,
            fileName: action.payload.fileName,
            url: uploadPayload.url,
            key: uploadPayload.filename || uploadPayload.url,
            mimeType: action.payload.mimeType,
            fileSize: action.payload.fileSize,
          }),
        })

        if (!attachmentResponse.ok) {
          throw new Error('Attachment create failed while syncing outbox')
        }
      }

      processed += 1
    } catch {
      remaining.push(action)
    }
  }

  await saveOutbox(remaining)
  return { remaining: remaining.length, processed }
}

