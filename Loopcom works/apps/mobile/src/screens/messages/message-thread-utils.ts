import { ChatMessage } from '../../types/models'

type DraftAttachment = {
  kind: 'IMAGE' | 'VIDEO' | 'FILE' | 'VOICE' | 'LOCATION'
  url?: string
  fileName?: string
  mimeType?: string
  sizeBytes?: number
  durationMs?: number
  latitude?: number
  longitude?: number
  localUri?: string
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

export function computeWaveformPlaybackFrame(params: {
  positionMs: number
  durationMs: number
  barsCount: number
  waveformWidth: number
}): {
  progress: number
  activeBars: number
  boundaryProgress: number
  dotX: number
} {
  const durationMs = Math.max(1, params.durationMs || 1)
  const barsCount = Math.max(0, params.barsCount || 0)
  const waveformWidth = Math.max(0, params.waveformWidth || 0)
  const safePositionMs = Math.max(0, Math.min(params.positionMs || 0, durationMs))
  const progress = clamp01(safePositionMs / durationMs)
  const activeBars = Math.floor(progress * barsCount)
  const boundaryProgress = barsCount > 0 ? activeBars / barsCount : 0
  // Dot follows real audio ratio (smooth), not discrete bar index — avoids lag vs playback.
  const dotX = progress * waveformWidth
  return { progress, activeBars, boundaryProgress, dotX }
}

export function toInvertedThreadItems<T>(items: T[]): T[] {
  return [...items].reverse()
}

export function buildSendDraftSnapshot(params: {
  text: string
  mediaDrafts: DraftAttachment[]
  replyTo: ChatMessage | null
}): {
  outgoingText: string
  outgoingDrafts: DraftAttachment[]
  outgoingReplyTo: ChatMessage | null
  trimmedText: string
  nextText: ''
} {
  const outgoingText = params.text
  const outgoingDrafts = [...params.mediaDrafts]
  const outgoingReplyTo = params.replyTo
  const trimmedText = outgoingText.trim()
  return {
    outgoingText,
    outgoingDrafts,
    outgoingReplyTo,
    trimmedText,
    nextText: '',
  }
}
