import { Alert, Linking, Platform } from 'react-native'
import * as FileSystem from 'expo-file-system/legacy'
import * as IntentLauncher from 'expo-intent-launcher'
import * as Sharing from 'expo-sharing'
import { API_BASE_URL } from '../config/env'
import { getAccessToken } from '../auth/secure-storage'
import { apiRequest, getValidAccessToken } from '../api/client'

const MEDIA_BASE_URL = API_BASE_URL || 'https://app.trimprony.com'

/** FLAG_GRANT_READ_URI_PERMISSION */
const FLAG_GRANT_READ = 1
/** FLAG_ACTIVITY_NEW_TASK */
const FLAG_NEW_TASK = 268435456

const EXT_BY_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/csv': 'csv',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/plain': 'txt',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
}

const MIME_BY_EXT: Record<string, string> = {
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
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
}

function isIpOrLocalHost(hostname: string): boolean {
  const host = String(hostname || '').toLowerCase()
  if (!host) return true
  if (host === 'localhost' || host === '127.0.0.1') return true
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
}

export function normalizeAttachmentUrl(rawUrl: string): string {
  const value = String(rawUrl || '').trim()
  if (!value) return ''
  try {
    const parsed = new URL(value, MEDIA_BASE_URL)
    if (isIpOrLocalHost(parsed.hostname)) {
      return `${MEDIA_BASE_URL}${parsed.pathname}${parsed.search}`
    }
    if (parsed.protocol === 'http:') parsed.protocol = 'https:'
    return parsed.toString()
  } catch {
    if (value.startsWith('/')) return `${MEDIA_BASE_URL}${value}`
    return value
  }
}

export function isPdfAttachment(mimeType?: string | null, fileName?: string | null): boolean {
  const mime = String(mimeType || '').toLowerCase()
  const name = String(fileName || '').toLowerCase()
  return mime.includes('pdf') || name.endsWith('.pdf')
}

export function getAttachmentKind(
  mimeType?: string | null,
  fileName?: string | null
): 'image' | 'video' | 'audio' | 'pdf' | 'other' {
  const mime = String(mimeType || '').toLowerCase()
  const name = String(fileName || '').toLowerCase()
  if (mime.startsWith('image/') || /\.(jpe?g|png|gif|webp|bmp|heic|heif)$/i.test(name)) return 'image'
  if (mime.startsWith('video/') || /\.(mp4|webm|mov|m4v|avi|3gp)$/i.test(name)) return 'video'
  if (mime.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(name)) return 'audio'
  if (isPdfAttachment(mimeType, fileName)) return 'pdf'
  return 'other'
}

function sanitizeFileName(fileName: string): string {
  const cleaned = String(fileName || 'attachment')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .trim()
  return cleaned || `attachment-${Date.now()}`
}

function inferMimeType(mimeType?: string | null, fileName?: string | null): string {
  const mime = String(mimeType || '').trim().toLowerCase()
  if (mime && mime !== 'application/octet-stream') return mime
  const name = String(fileName || '').toLowerCase()
  const ext = name.includes('.') ? name.split('.').pop() || '' : ''
  return MIME_BY_EXT[ext] || 'application/octet-stream'
}

function ensureFileExtension(fileName: string, mimeType: string): string {
  const safe = sanitizeFileName(fileName)
  if (safe.includes('.')) return safe
  const ext = EXT_BY_MIME[mimeType]
  return ext ? `${safe}.${ext}` : safe
}

export async function downloadAttachmentToCache(options: {
  url: string
  fileName?: string | null
  mimeType?: string | null
}): Promise<{ localUri: string; mimeType: string; fileName: string; remoteUrl: string }> {
  const url = normalizeAttachmentUrl(options.url)
  if (!url) throw new Error('This attachment has no download URL.')
  const mimeType = inferMimeType(options.mimeType, options.fileName)
  const fileName = ensureFileExtension(
    options.fileName || url.split('/').pop() || 'attachment',
    mimeType
  )
  const target = `${FileSystem.cacheDirectory}${Date.now()}-${fileName}`

  const headers: Record<string, string> = {
    // Required so API can treat this as a mobile client for permission checks.
    'User-Agent': 'TrimProMobile',
  }
  try {
    const token = await getAccessToken()
    if (token) headers.Authorization = `Bearer ${token}`
  } catch {
    // Public /uploads paths work without auth.
  }

  const result = await FileSystem.downloadAsync(url, target, { headers })
  if (result.status && result.status >= 400) {
    throw new Error(`Download failed (${result.status})`)
  }
  const info = await FileSystem.getInfoAsync(result.uri)
  if (!info.exists || (typeof info.size === 'number' && info.size <= 0)) {
    throw new Error('Downloaded file was empty.')
  }
  return { localUri: result.uri, mimeType, fileName, remoteUrl: url }
}

async function openAndroidContentUri(contentUri: string, mimeType: string): Promise<boolean> {
  const attempts: Array<{ type?: string; flags: number }> = [
    { type: mimeType, flags: FLAG_GRANT_READ },
    { type: mimeType, flags: FLAG_GRANT_READ | FLAG_NEW_TASK },
    { flags: FLAG_GRANT_READ },
    { type: '*/*', flags: FLAG_GRANT_READ },
  ]

  for (const attempt of attempts) {
    try {
      await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
        data: contentUri,
        category: 'android.intent.category.DEFAULT',
        ...attempt,
      })
      return true
    } catch {
      // try next variant
    }
  }
  return false
}

/**
 * Open an attachment with a system viewer.
 * Prefer the Android share/"Open with" sheet — it is the most reliable path.
 */
export async function openAttachment(options: {
  url: string
  fileName?: string | null
  mimeType?: string | null
}): Promise<void> {
  const url = normalizeAttachmentUrl(options.url)
  if (!url) {
    Alert.alert('Unable to open file', 'This attachment has no download URL.')
    return
  }

  try {
    const { localUri, mimeType, fileName } = await downloadAttachmentToCache(options)

    // 1) Share / Open-with sheet (most reliable on Android + iOS)
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(localUri, {
        mimeType,
        dialogTitle: `Open ${fileName}`,
        UTI: mimeType,
      })
      return
    }

    // 2) Android VIEW intent
    if (Platform.OS === 'android') {
      const contentUri = await FileSystem.getContentUriAsync(localUri)
      const opened = await openAndroidContentUri(contentUri, mimeType)
      if (opened) return
    }

    // 3) Browser fallback for public https URLs
    if (/^https?:\/\//i.test(url)) {
      await Linking.openURL(url)
      return
    }

    Alert.alert(
      'Unable to open file',
      'Install a PDF/Office viewer (Google Drive, Adobe Reader, or Microsoft Office), then try again.'
    )
  } catch (error: any) {
    const detail = error?.message || 'Unknown error'
    try {
      if (/^https?:\/\//i.test(url)) {
        await Linking.openURL(url)
        return
      }
    } catch {
      // fall through
    }
    Alert.alert('Unable to open file', `${detail}\n\nInstall a PDF/Office viewer and try again.`)
  }
}

/** Save a data URL (e.g. marked PNG) and open the system share sheet. */
export async function shareDataUrl(options: {
  dataUrl: string
  fileName?: string | null
}): Promise<void> {
  const match = String(options.dataUrl || '').match(/^data:([^;]+);base64,(.+)$/)
  if (!match) {
    Alert.alert('Unable to save', 'Marked image data was invalid.')
    return
  }
  const mimeType = match[1] || 'image/png'
  const base64 = match[2]
  const ext = mimeType.includes('jpeg') ? 'jpg' : 'png'
  const fileName = sanitizeFileName(
    (options.fileName || 'attachment').replace(/\.[^.]+$/, '') + `-marked.${ext}`
  )
  const target = `${FileSystem.cacheDirectory}${Date.now()}-${fileName}`
  await FileSystem.writeAsStringAsync(target, base64, {
    encoding: FileSystem.EncodingType.Base64,
  })

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(target, { mimeType, dialogTitle: fileName, UTI: mimeType })
    return
  }

  Alert.alert('Saved', `Marked image written to cache as ${fileName}`)
}

/**
 * Write a marked-up image data URL to the cache, upload it, and create a brand-new
 * attachment record linked to the given entity (job/request/task/issue/etc). This
 * always produces a copy — the original attachment is left untouched.
 */
export async function saveMarkupAsAttachmentCopy(options: {
  dataUrl: string
  fileName?: string | null
  entityType: string
  entityId: string
}): Promise<{ attachment: any }> {
  const match = String(options.dataUrl || '').match(/^data:([^;]+);base64,(.+)$/)
  if (!match) {
    throw new Error('Marked image data was invalid.')
  }
  const mimeType = match[1] || 'image/png'
  const base64 = match[2]
  const ext = mimeType.includes('jpeg') ? 'jpg' : 'png'
  const fileName = sanitizeFileName(
    (options.fileName || 'attachment').replace(/\.[^.]+$/, '') + `-marked.${ext}`
  )
  const target = `${FileSystem.cacheDirectory}${Date.now()}-${fileName}`

  try {
    await FileSystem.writeAsStringAsync(target, base64, {
      encoding: FileSystem.EncodingType.Base64,
    })

    const token = await getValidAccessToken()
    if (!token) throw new Error('Not authenticated')

    const upload = await FileSystem.uploadAsync(`${API_BASE_URL}/api/uploads`, target, {
      fieldName: 'file',
      httpMethod: 'POST',
      uploadType: FileSystem.FileSystemUploadType.MULTIPART,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      mimeType,
    })
    if (upload.status < 200 || upload.status >= 300) {
      throw new Error(`Upload failed (${upload.status})`)
    }
    const uploadBody = JSON.parse(upload.body || '{}')
    const info = await FileSystem.getInfoAsync(target)
    const fileSize = info.exists && typeof info.size === 'number' ? info.size : 0

    return await apiRequest<{ attachment: any }>('/api/attachments', 'POST', {
      entityType: options.entityType,
      entityId: options.entityId,
      fileName,
      url: uploadBody.url,
      key: uploadBody.filename || uploadBody.url,
      mimeType,
      fileSize,
    })
  } finally {
    void FileSystem.deleteAsync(target, { idempotent: true }).catch(() => {})
  }
}
