import { Alert, Linking } from 'react-native'
import * as DocumentPicker from 'expo-document-picker'
import * as ImagePicker from 'expo-image-picker'
import * as FileSystem from 'expo-file-system/legacy'
import { API_BASE_URL } from '../config/env'
import { getValidAccessToken } from '../api/client'

export type AttachmentPickAction =
  | 'take-photo'
  | 'record-video'
  | 'choose-photos'
  | 'choose-videos'
  | 'choose-audio'
  | 'choose-document'

export type AttachmentKind = 'image' | 'video' | 'audio' | 'document'

export interface LocalAttachmentFile {
  localId: string
  uri: string
  name: string
  mimeType: string
  sizeBytes: number
  kind: AttachmentKind
}

export interface UploadResponse<T = unknown> {
  raw: T
}

export interface UploadQueueItem<T = unknown> {
  id: string
  file: LocalAttachmentFile
  status: 'pending' | 'uploading' | 'success' | 'failed' | 'cancelled'
  progress: number
  error?: string
  result?: T
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
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  m4a: 'audio/m4a',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
}

function inferMimeType(name: string, fallback: string): string {
  const ext = String(name || '')
    .split('.')
    .pop()
    ?.trim()
    .toLowerCase()
  if (!ext) return fallback
  return MIME_BY_EXTENSION[ext] || fallback
}

function kindFromMime(mimeType: string, fallback: AttachmentKind = 'document'): AttachmentKind {
  const mime = String(mimeType || '').toLowerCase()
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return fallback
}

function toLocalFile(input: {
  uri: string
  name?: string | null
  mimeType?: string | null
  size?: number | null
  kind: AttachmentKind
}): LocalAttachmentFile {
  const fallbackNameByKind: Record<AttachmentKind, string> = {
    image: `image-${Date.now()}.jpg`,
    video: `video-${Date.now()}.mp4`,
    audio: `audio-${Date.now()}.mp3`,
    document: `document-${Date.now()}.pdf`,
  }
  const name = input.name?.trim() || fallbackNameByKind[input.kind]
  const kindFallbackMime: Record<AttachmentKind, string> = {
    image: 'image/jpeg',
    video: 'video/mp4',
    audio: 'audio/mpeg',
    document: 'application/octet-stream',
  }
  const mimeType = inferMimeType(name, (input.mimeType || kindFallbackMime[input.kind]).toLowerCase())
  return {
    localId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    uri: input.uri,
    name,
    mimeType,
    sizeBytes: Number(input.size || 0),
    kind: kindFromMime(mimeType, input.kind),
  }
}

async function ensureCameraPermission(): Promise<boolean> {
  const permission = await ImagePicker.requestCameraPermissionsAsync()
  if (!permission.granted) {
    Alert.alert(
      'Camera permission required',
      'Enable camera permission in Settings to capture photos and videos.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Open Settings', onPress: () => void Linking.openSettings() },
      ]
    )
    return false
  }
  return true
}

async function ensureMediaPermission(): Promise<boolean> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync()
  if (!permission.granted) {
    Alert.alert(
      'Media permission required',
      'Enable photo and video library permission in Settings to choose files.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Open Settings', onPress: () => void Linking.openSettings() },
      ]
    )
    return false
  }
  return true
}

export async function pickAttachmentsByAction(action: AttachmentPickAction): Promise<LocalAttachmentFile[]> {
  if (action === 'take-photo') {
    if (!(await ensureCameraPermission())) return []
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      quality: 0.85,
    })
    const assets = Array.isArray(result?.assets) ? result.assets : []
    if (result.canceled || assets.length === 0) return []
    return assets
      .filter((asset) => !!asset?.uri)
      .map((asset) =>
      toLocalFile({
        uri: asset.uri,
        name: asset.fileName,
        mimeType: asset.mimeType,
        size: asset.fileSize,
        kind: 'image',
      })
    )
  }

  if (action === 'record-video') {
    if (!(await ensureCameraPermission())) return []
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['videos'],
      quality: 0.85,
      videoMaxDuration: 300,
    })
    const assets = Array.isArray(result?.assets) ? result.assets : []
    if (result.canceled || assets.length === 0) return []
    return assets
      .filter((asset) => !!asset?.uri)
      .map((asset) =>
      toLocalFile({
        uri: asset.uri,
        name: asset.fileName,
        mimeType: asset.mimeType,
        size: asset.fileSize,
        kind: 'video',
      })
    )
  }

  if (action === 'choose-photos') {
    if (!(await ensureMediaPermission())) return []
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      quality: 0.9,
    })
    const assets = Array.isArray(result?.assets) ? result.assets : []
    if (result.canceled || assets.length === 0) return []
    return assets
      .filter((asset) => !!asset?.uri)
      .map((asset) =>
      toLocalFile({
        uri: asset.uri,
        name: asset.fileName,
        mimeType: asset.mimeType,
        size: asset.fileSize,
        kind: 'image',
      })
    )
  }

  if (action === 'choose-videos') {
    if (!(await ensureMediaPermission())) return []
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['videos'],
      allowsMultipleSelection: true,
      quality: 0.85,
    })
    const assets = Array.isArray(result?.assets) ? result.assets : []
    if (result.canceled || assets.length === 0) return []
    return assets
      .filter((asset) => !!asset?.uri)
      .map((asset) =>
      toLocalFile({
        uri: asset.uri,
        name: asset.fileName,
        mimeType: asset.mimeType,
        size: asset.fileSize,
        kind: 'video',
      })
    )
  }

  if (action === 'choose-audio') {
    const docs = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: true,
      type: ['audio/*', 'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/wav'],
    })
    if (docs.canceled) return []
    return docs.assets.map((asset) =>
      toLocalFile({
        uri: asset.uri,
        name: asset.name,
        mimeType: asset.mimeType,
        size: asset.size,
        kind: 'audio',
      })
    )
  }

  const docs = await DocumentPicker.getDocumentAsync({
    copyToCacheDirectory: true,
    multiple: true,
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
  })
  if (docs.canceled) return []
  return docs.assets.map((asset) =>
    toLocalFile({
      uri: asset.uri,
      name: asset.name,
      mimeType: asset.mimeType,
      size: asset.size,
      kind: 'document',
    })
  )
}

export function fileTypeIconName(file: LocalAttachmentFile): string {
  if (file.kind === 'image') return 'image-outline'
  if (file.kind === 'video') return 'videocam-outline'
  if (file.kind === 'audio') return 'musical-notes-outline'
  return 'document-text-outline'
}

export function formatFileSize(sizeBytes: number): string {
  const size = Number(sizeBytes || 0)
  if (size <= 0) return 'Unknown size'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

export function uploadFileWithProgress<T>(
  endpointPath: string,
  file: LocalAttachmentFile,
  onProgress?: (progress: number) => void
): { promise: Promise<UploadResponse<T>>; cancel: () => void } {
  let uploadTask: FileSystem.UploadTask | null = null
  let cancelled = false
  let copiedUploadUri: string | null = null
  const promise = new Promise<UploadResponse<T>>(async (resolve, reject) => {
    try {
      const token = await getValidAccessToken()
      if (!token) {
        reject(new Error('Not authenticated'))
        return
      }
      if (cancelled) {
        reject(new Error('Upload cancelled'))
        return
      }
      let uploadUri = file.uri
      const needsUriCopy =
        uploadUri.startsWith('content://') ||
        uploadUri.startsWith('ph://') ||
        uploadUri.startsWith('assets-library://')
      if (needsUriCopy) {
        const baseDir = FileSystem.cacheDirectory || FileSystem.documentDirectory
        if (!baseDir) {
          reject(new Error('Unable to prepare file for upload'))
          return
        }
        const safeName = (file.name || `upload-${Date.now()}`).replace(/[^\w.\-]/g, '_')
        copiedUploadUri = `${baseDir}upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`
        await FileSystem.copyAsync({ from: uploadUri, to: copiedUploadUri })
        uploadUri = copiedUploadUri
      }
      const runUpload = async (accessToken: string) => {
        uploadTask = FileSystem.createUploadTask(
          `${API_BASE_URL}${endpointPath}`,
          uploadUri,
          {
            fieldName: 'file',
            httpMethod: 'POST',
            uploadType: FileSystem.FileSystemUploadType.MULTIPART,
            mimeType: file.mimeType,
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: 'application/json',
            },
          },
          (progressEvent) => {
            if (!progressEvent.totalBytesExpectedToSend) return
            const progress = Math.max(
              0,
              Math.min(1, progressEvent.totalBytesSent / progressEvent.totalBytesExpectedToSend)
            )
            onProgress?.(progress)
          }
        )
        return uploadTask.uploadAsync()
      }

      let result = await runUpload(token)
      let status = Number(result?.status || 0)
      if (status === 401) {
        const refreshedToken = await getValidAccessToken(true)
        if (refreshedToken) {
          result = await runUpload(refreshedToken)
          status = Number(result?.status || 0)
        }
      }

      let body: any = {}
      try {
        body = JSON.parse(result?.body || '{}')
      } catch {
        body = {}
      }
      if (status < 200 || status >= 300) {
        reject(new Error(body?.error || `Upload failed (${status})`))
        return
      }
      onProgress?.(1)
      resolve({ raw: body as T })
      if (copiedUploadUri) {
        void FileSystem.deleteAsync(copiedUploadUri, { idempotent: true }).catch(() => {})
        copiedUploadUri = null
      }
    } catch (error) {
      if (copiedUploadUri) {
        void FileSystem.deleteAsync(copiedUploadUri, { idempotent: true }).catch(() => {})
        copiedUploadUri = null
      }
      reject(error instanceof Error ? error : new Error('Upload failed'))
    }
  })

  return {
    promise,
    cancel: () => {
      cancelled = true
      if (uploadTask) {
        void uploadTask.cancelAsync().catch(() => {})
      }
      uploadTask = null
      if (copiedUploadUri) {
        void FileSystem.deleteAsync(copiedUploadUri, { idempotent: true }).catch(() => {})
        copiedUploadUri = null
      }
    },
  }
}
