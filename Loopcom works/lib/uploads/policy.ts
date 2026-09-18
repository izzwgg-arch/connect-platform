export const MAX_IMAGE_FILE_BYTES = 15 * 1024 * 1024
export const MAX_VIDEO_FILE_BYTES = 1024 * 1024 * 1024
export const MAX_DOCUMENT_FILE_BYTES = 1024 * 1024 * 1024
export const MAX_AUDIO_FILE_BYTES = 1024 * 1024 * 1024

export const ALLOWED_DOCUMENT_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
])

export const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/svg+xml',
  'image/heic',
  'image/heif',
  'image/webp',
])

export const ALLOWED_VIDEO_MIME_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/x-m4v',
  'video/webm',
  'video/3gpp',
  'video/3gpp2',
  'video/mpeg',
  'video/x-msvideo',
])

export const ALLOWED_AUDIO_MIME_TYPES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/m4a',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/3gpp',
  'audio/amr',
  'audio/webm',
  'audio/ogg',
  'audio/opus',
  'audio/flac',
  'audio/x-flac',
])

const MIME_TO_EXT: Record<string, string> = {
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
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/x-m4v': 'm4v',
  'video/webm': 'webm',
  'video/3gpp': '3gp',
  'video/3gpp2': '3g2',
  'video/mpeg': 'mpeg',
  'video/x-msvideo': 'avi',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/m4a': 'm4a',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/3gpp': '3gp',
  'audio/amr': 'amr',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
}

const EXT_TO_MIME: Record<string, string> = {
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
  svg: 'image/svg+xml',
  heic: 'image/heic',
  heif: 'image/heif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  mpeg: 'video/mpeg',
  mpg: 'video/mpeg',
  avi: 'video/x-msvideo',
  webm: 'video/webm',
  '3gp': 'video/3gpp',
  '3g2': 'video/3gpp2',
  mp3: 'audio/mpeg',
  m4a: 'audio/m4a',
  aac: 'audio/aac',
  wav: 'audio/wav',
  amr: 'audio/amr',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
}

const MIME_ALIASES: Record<string, string> = {
  'binary/octet-stream': 'application/octet-stream',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
  'audio/3gp': 'audio/3gpp',
  'audio/mp3': 'audio/mpeg',
  'audio/x-mp3': 'audio/mpeg',
  'audio/mpg': 'audio/mpeg',
  'audio/x-mpeg': 'audio/mpeg',
  'video/3gp': 'video/3gpp',
}

function mimeFromFileName(fileName?: string | null): string | null {
  const ext = String(fileName || '')
    .split('.')
    .pop()
    ?.trim()
    .toLowerCase()
  if (!ext) return null
  return EXT_TO_MIME[ext] || null
}

export function resolveUploadMimeType(mimeType: string, fileName?: string | null): string {
  const normalized = normalizeMimeType(mimeType)
  const aliased = MIME_ALIASES[normalized] || normalized
  if (aliased && aliased !== 'application/octet-stream') {
    return aliased
  }
  const inferred = mimeFromFileName(fileName)
  if (inferred) return inferred
  return aliased || 'application/octet-stream'
}

export function normalizeMimeType(mimeType: string): string {
  return String(mimeType || '').trim().toLowerCase()
}

export function isAllowedUploadMimeType(mimeType: string, fileName?: string | null): boolean {
  const normalized = resolveUploadMimeType(mimeType, fileName)
  if (
    ALLOWED_DOCUMENT_MIME_TYPES.has(normalized) ||
    ALLOWED_IMAGE_MIME_TYPES.has(normalized) ||
    ALLOWED_VIDEO_MIME_TYPES.has(normalized) ||
    ALLOWED_AUDIO_MIME_TYPES.has(normalized)
  ) {
    return true
  }
  // Accept common media families so mp3/mp4 (and close variants) work on all attachment surfaces.
  return normalized.startsWith('audio/') || normalized.startsWith('video/')
}

export function getMaxBytesForMimeType(mimeType: string, fileName?: string | null): number {
  const normalized = resolveUploadMimeType(mimeType, fileName)
  if (ALLOWED_IMAGE_MIME_TYPES.has(normalized) || normalized.startsWith('image/')) {
    return MAX_IMAGE_FILE_BYTES
  }
  if (ALLOWED_VIDEO_MIME_TYPES.has(normalized) || normalized.startsWith('video/')) {
    return MAX_VIDEO_FILE_BYTES
  }
  if (ALLOWED_AUDIO_MIME_TYPES.has(normalized) || normalized.startsWith('audio/')) {
    return MAX_AUDIO_FILE_BYTES
  }
  return MAX_DOCUMENT_FILE_BYTES
}

export function safeExtFromMimeType(mimeType: string, fileName?: string | null): string {
  const normalized = resolveUploadMimeType(mimeType, fileName)
  return MIME_TO_EXT[normalized] || 'bin'
}
