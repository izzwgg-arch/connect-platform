'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'

export type MsgAttachment = {
  kind: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE' | 'LOCATION'
  url: string
  fileName?: string | null
  mimeType?: string | null
  durationMs?: number | null
  sizeBytes?: number | null
  latitude?: number | null
  longitude?: number | null
}

export type ReactionEntry = { emoji: string; userId: string; userName: string }

export type ReplyInfo = {
  messageId: string
  senderName: string
  textPreview: string
  type?: string | null
} | null

export type NormalizedMsg = {
  id: string
  isMine: boolean
  senderName?: string | null   // sender display name (only rendered in TEAM group chat, but kept for reply quotes)
  text: string | null
  createdAt: string
  status?: string
  jobId?: string | null
  jobNumber?: string | null
  jobName?: string | null
  attachments: MsgAttachment[]
  replyTo?: ReplyInfo
  reactions: ReactionEntry[]
  canInteract: boolean   // reply/react supported on internal chats (TEAM / DM / JOB_THREAD)
}

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏']

export function attachmentPreviewLabel(att?: MsgAttachment) {
  if (!att) return 'Attachment'
  if (att.kind === 'IMAGE') return 'Photo'
  if (att.kind === 'VIDEO') return 'Video'
  if (att.kind === 'AUDIO') return 'Voice note'
  if (att.kind === 'LOCATION') return 'Location'
  return att.fileName || 'File'
}

export function replyPreviewText(msg: NormalizedMsg) {
  return msg.text || attachmentPreviewLabel(msg.attachments[0])
}

export function dateSep(iso: string) {
  const d = new Date(iso)
  const t = new Date()
  const y = new Date(t); y.setDate(t.getDate() - 1)
  if (d.toDateString() === t.toDateString()) return 'Today'
  if (d.toDateString() === y.toDateString()) return 'Yesterday'
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
}

export function msgTimeStr(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

/** Relative `/uploads/...` URLs need an origin for `<audio>` / `<video>` in some browsers and dev setups. */
export function resolveMessageMediaUrl(url: string): string {
  if (!url) return url
  if (/^https?:\/\//i.test(url)) return url
  if (typeof window === 'undefined') return url
  const path = url.startsWith('/') ? url : `/${url}`
  return `${window.location.origin}${path}`
}

// Convert a raw ChatMessage (team) to NormalizedMsg
export function normaliseTeamMsg(raw: any, myId: string): NormalizedMsg {
  const atts: MsgAttachment[] = (raw.attachments || []).map((a: any): MsgAttachment => {
    const k = String(a.kind || '').toUpperCase()
    const kind: MsgAttachment['kind'] =
      k === 'IMAGE' ? 'IMAGE'
      : k === 'VIDEO' ? 'VIDEO'
      : k === 'VOICE' ? 'AUDIO'
      : k === 'LOCATION' ? 'LOCATION'
      : 'FILE'
    return {
      kind,
      url: resolveMessageMediaUrl(typeof a.url === 'string' ? a.url : ''),
      fileName: a.fileName,
      mimeType: a.mimeType,
      durationMs: a.durationMs,
      sizeBytes: a.sizeBytes,
      latitude: a.latitude,
      longitude: a.longitude,
    }
  })
  const sender = raw.sender
  // Always resolve the sender's display name (used for group labels and reply quotes),
  // even though the bubble only renders it visibly for non-mine messages in group chats.
  const senderName = sender
    ? (`${sender.firstName || ''} ${sender.lastName || ''}`.trim() || sender.email)
    : null
  const replyTo: ReplyInfo = raw.replyTo
    ? {
        messageId: raw.replyTo.messageId,
        senderName: raw.replyTo.senderName || 'Unknown',
        textPreview: raw.replyTo.textPreview || '',
        type: raw.replyTo.type || null,
      }
    : null
  const reactions: ReactionEntry[] = Array.isArray(raw.reactions)
    ? raw.reactions.map((r: any) => ({ emoji: r.emoji, userId: r.userId, userName: r.userName }))
    : []
  return {
    id: raw.id,
    isMine: String(raw.senderId) === String(myId),
    senderName,
    text: raw.text || null,
    createdAt: raw.createdAt,
    status: raw.status,
    jobId: raw.jobId,
    jobNumber: raw.jobNumber,
    jobName: raw.jobName,
    attachments: atts,
    replyTo,
    reactions,
    canInteract: true,
  }
}

function ReactionPicker({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])
  return (
    <div
      ref={ref}
      className="absolute bottom-full mb-1.5 z-20 flex items-center gap-0.5 px-1.5 py-1 rounded-2xl bg-white shadow-lg border border-gray-100"
    >
      {QUICK_REACTIONS.map((emoji) => (
        <button
          key={emoji}
          onClick={() => onPick(emoji)}
          className="w-7 h-7 flex items-center justify-center text-base rounded-full hover:bg-gray-100 hover:scale-110 transition-transform"
        >
          {emoji}
        </button>
      ))}
    </div>
  )
}

export function MsgBubble({
  msg,
  showSenderName,
  myId,
  isHighlighted,
  showJobLink = true,
  onReply,
  onToggleReaction,
  onJumpTo,
  onDelete,
}: {
  msg: NormalizedMsg
  showSenderName: boolean
  myId: string
  isHighlighted?: boolean
  showJobLink?: boolean
  onReply: (msg: NormalizedMsg) => void
  onToggleReaction: (messageId: string, emoji: string) => void
  onJumpTo: (messageId: string) => void
  onDelete?: (msg: NormalizedMsg) => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)

  const reactionGroups = useMemo(() => {
    const map = new Map<string, { emoji: string; count: number; mine: boolean; names: string[] }>()
    for (const r of msg.reactions) {
      const entry = map.get(r.emoji) || { emoji: r.emoji, count: 0, mine: false, names: [] }
      entry.count += 1
      entry.names.push(r.userName)
      if (String(r.userId) === String(myId)) entry.mine = true
      map.set(r.emoji, entry)
    }
    return Array.from(map.values())
  }, [msg.reactions, myId])

  return (
    <div
      id={`msg-${msg.id}`}
      className={`flex group ${msg.isMine ? 'justify-end' : 'justify-start'} ${
        isHighlighted ? 'transition-colors duration-500' : ''
      }`}
    >
      <div className={`flex items-end gap-1 max-w-[80%] ${msg.isMine ? 'flex-row-reverse' : 'flex-row'}`}>
        {/* Hover toolbar: reply + react + delete */}
        {msg.canInteract && (
          <div className="relative flex items-center gap-0.5 pb-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity flex-shrink-0">
            <button
              type="button"
              title="Reply"
              onClick={() => onReply(msg)}
              className="w-6 h-6 flex items-center justify-center rounded-full text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 016 6v1" /></svg>
            </button>
            <button
              type="button"
              title="React"
              onClick={() => setPickerOpen((p) => !p)}
              className="w-6 h-6 flex items-center justify-center rounded-full text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            </button>
            {msg.isMine && onDelete && (
              <button
                type="button"
                title="Delete"
                onClick={() => onDelete(msg)}
                className="w-6 h-6 flex items-center justify-center rounded-full text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
              </button>
            )}
            {pickerOpen && (
              <ReactionPicker
                onPick={(emoji) => { onToggleReaction(msg.id, emoji); setPickerOpen(false) }}
                onClose={() => setPickerOpen(false)}
              />
            )}
          </div>
        )}

      <div className={`max-w-full flex flex-col ${msg.isMine ? 'items-end' : 'items-start'} ${isHighlighted ? 'rounded-2xl ring-2 ring-amber-300' : ''}`}>
        {/* Sender name (group only) */}
        {!msg.isMine && showSenderName && msg.senderName && (
          <span className="text-[11px] font-semibold text-emerald-700 mb-0.5 ml-1">{msg.senderName}</span>
        )}

        {/* Reply quote */}
        {msg.replyTo && (
          <button
            type="button"
            onClick={() => onJumpTo(msg.replyTo!.messageId)}
            className={`mb-1 max-w-[280px] text-left px-2.5 py-1.5 rounded-lg border-l-2 text-xs transition-colors ${
              msg.isMine
                ? 'bg-[#d9fdd3] border-[#25d366] text-[#075e54] hover:bg-[#c6f0bf]'
                : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50'
            }`}
          >
            <div className="font-semibold truncate">{msg.replyTo.senderName}</div>
            <div className="truncate opacity-80">{msg.replyTo.textPreview || 'Attachment'}</div>
          </button>
        )}

        {/* Job link (hidden inside job chat popup) */}
        {showJobLink && msg.jobId && (
          <a
            href={`/dashboard/jobs/${msg.jobId}`}
            className={`mb-1.5 flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium transition-colors ${
              msg.isMine
                ? 'bg-[#25d366] text-white hover:bg-[#1ebe57]'
                : 'bg-white text-gray-700 hover:bg-gray-50 shadow-sm'
            }`}
          >
            <svg className="w-3.5 h-3.5 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
            Job #{msg.jobNumber || 'N/A'}{msg.jobName ? ` · ${msg.jobName}` : ''}
          </a>
        )}

        {/* Attachments */}
        {msg.attachments.map((att, idx) => (
          <AttachmentItem key={idx} att={att} isMine={msg.isMine} />
        ))}

        {/* Text bubble */}
        {(msg.text || msg.attachments.length === 0) && (
          <div
            className={`relative px-3 py-1.5 leading-relaxed shadow-sm ${
              msg.isMine
                ? 'bg-[#dcf8c6] text-[#111b21] rounded-2xl rounded-br-md'
                : 'bg-white text-[#111b21] rounded-2xl rounded-bl-md'
            }`}
          >
            {msg.text && <p className="text-sm whitespace-pre-wrap break-words">{msg.text}</p>}
            <div className={`mt-0.5 flex items-center gap-1 justify-end ${msg.isMine ? 'text-[#667781]' : 'text-[#667781]'}`}>
              <span className="text-[10px]">{msgTimeStr(msg.createdAt)}</span>
              {msg.isMine && (
                <span className="text-[10px] text-[#53bdeb]">
                  {msg.status === 'READ' || msg.status === 'DELIVERED' ? '✓✓' : '✓'}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Timestamp when text-less media */}
        {msg.text === null && msg.attachments.length > 0 && (
          <span className={`text-[10px] mt-0.5 ${msg.isMine ? 'text-gray-400' : 'text-gray-400'}`}>
            {msgTimeStr(msg.createdAt)}
            {msg.isMine && <span className="ml-1">{msg.status === 'READ' || msg.status === 'DELIVERED' ? '✓✓' : '✓'}</span>}
          </span>
        )}

        {/* Reaction chips */}
        {reactionGroups.length > 0 && (
          <div className={`flex flex-wrap gap-1 mt-1 ${msg.isMine ? 'justify-end' : 'justify-start'}`}>
            {reactionGroups.map((g) => (
              <button
                key={g.emoji}
                type="button"
                title={g.names.join(', ')}
                onClick={() => onToggleReaction(msg.id, g.emoji)}
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] border transition-colors ${
                  g.mine
                    ? 'bg-[#dcf8c6] border-[#25d366]/40 text-[#075e54] hover:bg-[#c6f0bf]'
                    : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                }`}
              >
                <span>{g.emoji}</span>
                <span className="font-medium">{g.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      </div>
    </div>
  )
}

function AttachmentItem({ att, isMine }: { att: MsgAttachment; isMine: boolean }) {
  if (att.kind === 'IMAGE') {
    const src = resolveMessageMediaUrl(att.url)
    return (
      <a href={src} target="_blank" rel="noreferrer" className="block mb-1">
        <img
          src={src}
          alt={att.fileName || 'Image'}
          className="rounded-2xl max-h-[260px] max-w-[280px] object-cover cursor-pointer hover:opacity-90 transition-opacity"
        />
      </a>
    )
  }
  if (att.kind === 'VIDEO') {
    const src = resolveMessageMediaUrl(att.url)
    return (
      <video
        controls
        src={src}
        className="rounded-2xl max-h-[240px] max-w-[280px] mb-1"
      />
    )
  }
  if (att.kind === 'AUDIO') {
    const src = resolveMessageMediaUrl(att.url)
    return (
      <div className={`flex items-center gap-2 px-3 py-2 rounded-2xl mb-1 ${isMine ? 'bg-[#dcf8c6]' : 'bg-white shadow-sm'}`}>
        <svg className={`w-4 h-4 flex-shrink-0 ${isMine ? 'text-[#075e54]' : 'text-gray-500'}`} fill="currentColor" viewBox="0 0 24 24"><path d="M12 3a9 9 0 110 18A9 9 0 0112 3zm0 2a7 7 0 100 14A7 7 0 0012 5zm-1 4h2v6h-2V9zM10 9a1 1 0 11-2 0 1 1 0 012 0zm6 0a1 1 0 11-2 0 1 1 0 012 0z"/></svg>
        <audio controls src={src} preload="metadata" className="h-7 w-40 opacity-90" />
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          className={`text-[10px] underline ${isMine ? 'text-[#075e54]' : 'text-gray-500'}`}
        >
          Open
        </a>
        {att.durationMs && (
          <span className={`text-[10px] flex-shrink-0 ${isMine ? 'text-[#667781]' : 'text-gray-500'}`}>
            {Math.round(att.durationMs / 1000)}s
          </span>
        )}
      </div>
    )
  }
  if (att.kind === 'LOCATION') {
    return (
      <a
        href={`https://maps.google.com/?q=${att.latitude},${att.longitude}`}
        target="_blank"
        rel="noreferrer"
        className={`flex items-center gap-2 px-3 py-2 rounded-2xl mb-1 text-sm shadow-sm ${isMine ? 'bg-[#dcf8c6] text-[#111b21]' : 'bg-white text-gray-700'} hover:opacity-80 transition-opacity`}
      >
        <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
        Open in Maps
      </a>
    )
  }
  // FILE
  return (
    <a
      href={resolveMessageMediaUrl(att.url)}
      target="_blank"
      rel="noreferrer"
      className={`flex items-center gap-2 px-3 py-2 rounded-2xl mb-1 text-sm max-w-[240px] transition-opacity hover:opacity-80 shadow-sm ${isMine ? 'bg-[#dcf8c6] text-[#111b21]' : 'bg-white text-gray-700'}`}
    >
      <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
      <div className="min-w-0">
        <div className="truncate font-medium">{att.fileName || 'Download file'}</div>
        {att.sizeBytes && <div className="text-[10px] opacity-70">{(att.sizeBytes / 1024).toFixed(0)} KB</div>}
      </div>
    </a>
  )
}

// ─── Composer ──────────────────────────────────────────────────────────────────

export type DraftMedia = { url: string; type: string; mimeType: string; filename: string; preview?: string }

export function Composer({
  isSms,
  onSend,
  disabled,
  replyPreview,
  onClearReply,
}: {
  isSms: boolean
  onSend: (text: string, media: DraftMedia[], durationMs?: number) => Promise<void>
  disabled?: boolean
  replyPreview?: { senderName: string; textPreview: string } | null
  onClearReply?: () => void
}) {
  const [text, setText] = useState('')
  const [media, setMedia] = useState<DraftMedia[]>([])
  const [sending, setSending] = useState(false)
  const [recording, setRecording] = useState(false)
  const [recordStart, setRecordStart] = useState(0)
  const [recSecs, setRecSecs] = useState(0)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const canSend = (text.trim().length > 0 || media.length > 0) && !sending && !recording

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }, [text])

  const handleUpload = async (files: FileList | null) => {
    if (!files || !files.length) return
    const token = localStorage.getItem('accessToken')
    for (let i = 0; i < Math.min(files.length, 8); i++) {
      const f = files[i]
      const fd = new FormData(); fd.append('file', f)
      const res = await fetch('/api/uploads/messages', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        alert(err.error || `Upload failed (${res.status})`)
        continue
      }
      const { url } = await res.json()
      const mediaType = f.type.startsWith('image/') ? 'image'
        : f.type.startsWith('video/') ? 'video'
        : f.type.startsWith('audio/') ? 'audio'
        : 'file'
      const preview = mediaType === 'image' ? URL.createObjectURL(f) : undefined
      setMedia((p) => [...p, { url, type: mediaType, mimeType: f.type, filename: f.name, preview }])
    }
  }

  const startRecording = async () => {
    if (recording) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeCandidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
      const mimeType = mimeCandidates.find((t) => MediaRecorder.isTypeSupported(t)) || ''
      const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      recorderRef.current = rec
      chunksRef.current = []
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      rec.start(250)
      setRecording(true)
      setRecordStart(Date.now())
      setRecSecs(0)
      timerRef.current = setInterval(() => setRecSecs((s) => s + 1), 1000)
    } catch {
      alert('Microphone access denied')
    }
  }

  const stopRecording = async () => {
    if (!recorderRef.current || !recording) return
    if (timerRef.current) clearInterval(timerRef.current)
    const durMs = Date.now() - recordStart
    const rec = recorderRef.current
    await new Promise<void>((resolve) => {
      rec.onstop = async () => {
        try {
          if (typeof rec.requestData === 'function') {
            try {
              rec.requestData()
            } catch {
              /* ignore */
            }
          }
          await new Promise((r) => setTimeout(r, 80))
          const blobType = rec.mimeType || 'audio/webm'
          const blob = new Blob(chunksRef.current, { type: blobType })
          if (!blob.size) {
            alert('Recording was empty. Try again and speak closer to the mic.')
            return
          }
          const ext = blobType.includes('mp4') ? 'm4a' : 'webm'
          const file = new File([blob], `voice-${Date.now()}.${ext}`, { type: blobType })
          const fd = new FormData()
          fd.append('file', file)
          const token = localStorage.getItem('accessToken')
          const res = await fetch('/api/uploads/messages', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: fd,
          })
          if (!res.ok) {
            const err = await res.json().catch(() => ({}))
            alert(err.error || `Voice upload failed (${res.status})`)
            return
          }
          const { url } = await res.json()
          setSending(true)
          await onSend('', [{ url, type: 'audio', mimeType: blobType, filename: file.name }], durMs).catch(() => {})
          setSending(false)
        } finally {
          resolve()
        }
      }
      rec.stop()
      rec.stream.getTracks().forEach((t) => t.stop())
    })
    setRecording(false); setRecSecs(0); recorderRef.current = null
  }

  const cancelRecording = () => {
    if (timerRef.current) clearInterval(timerRef.current)
    recorderRef.current?.stop()
    recorderRef.current?.stream.getTracks().forEach((t) => t.stop())
    recorderRef.current = null; chunksRef.current = []
    setRecording(false); setRecSecs(0)
  }

  const handleSend = async () => {
    if (!canSend) return
    setSending(true)
    await onSend(text.trim(), media).catch(() => {})
    setText(''); setMedia([])
    setSending(false)
  }

  return (
    <div className="bg-[#f0f2f5] border-t border-black/5 px-3 py-2.5">
      {/* Reply preview */}
      {replyPreview && (
        <div className="mb-2 flex items-center gap-2 pl-3 pr-2 py-1.5 rounded-xl bg-white border-l-[3px] border-[#00a884] shadow-sm">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-[#008069] truncate">Replying to {replyPreview.senderName}</div>
            <div className="text-xs text-[#667781] truncate">{replyPreview.textPreview}</div>
          </div>
          <button
            type="button"
            onClick={onClearReply}
            className="w-5 h-5 flex-shrink-0 flex items-center justify-center rounded-full text-gray-400 hover:text-[#008069] hover:bg-emerald-50 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
      )}

      {/* Draft media row */}
      {media.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {media.map((m, i) => (
            <div key={i} className="relative group">
              {m.preview
                ? <img src={m.preview} alt="" className="w-14 h-14 rounded-xl object-cover border border-gray-100" />
                : (
                  <div className="w-14 h-14 rounded-xl bg-gray-100 flex flex-col items-center justify-center gap-0.5">
                    <span className="text-lg">{m.type === 'audio' ? '🎙' : m.type === 'video' ? '🎬' : '📄'}</span>
                    <span className="text-[9px] text-gray-500 truncate px-1 w-full text-center">{m.filename.slice(0, 8)}</span>
                  </div>
                )
              }
              <button
                onClick={() => setMedia((p) => p.filter((_, j) => j !== i))}
                className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-gray-800 text-white rounded-full text-[10px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              >×</button>
            </div>
          ))}
        </div>
      )}

      {recording ? (
        /* Recording UI */
        <div className="flex items-center gap-3 h-10">
          <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
          <span className="text-sm text-gray-600 flex-1 font-medium tabular-nums">
            Recording {String(Math.floor(recSecs / 60)).padStart(2, '0')}:{String(recSecs % 60).padStart(2, '0')}
          </span>
          <button onClick={cancelRecording} className="text-xs text-gray-400 hover:text-gray-600 px-2">Cancel</button>
          <button
            onClick={stopRecording}
            className="h-9 px-4 rounded-full bg-[#25d366] hover:bg-[#1ebe57] text-white text-sm font-medium transition-colors"
          >
            Send
          </button>
        </div>
      ) : (
        <div className="flex items-end gap-2">
          {/* Attach */}
          <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => handleUpload(e.target.files)} />
          <button
            type="button"
            title="Attach file or media"
            onClick={() => fileRef.current?.click()}
            disabled={disabled}
            className="h-9 w-9 rounded-xl flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors flex-shrink-0"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
          </button>

          {/* Mic */}
          <button
            type="button"
            title="Record voice note"
            onClick={startRecording}
            disabled={disabled}
            className="h-9 w-9 rounded-xl flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors flex-shrink-0"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
          </button>

          {/* Text */}
          <textarea
            ref={textareaRef}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
            placeholder={isSms ? 'Type an SMS…' : 'Type a message…'}
            disabled={disabled || sending}
            className="flex-1 resize-none rounded-3xl border border-gray-200 bg-white px-4 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/15 focus:border-emerald-300 transition-shadow min-h-[38px] shadow-sm"
          />

          {/* Send */}
          <button
            type="button"
            onClick={handleSend}
            disabled={!canSend}
            className="h-9 w-9 rounded-full flex items-center justify-center bg-[#25d366] hover:bg-[#1ebe57] disabled:opacity-30 text-white transition-colors flex-shrink-0"
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z" /></svg>
          </button>
        </div>
      )}

      {isSms && (
        <p className="mt-1.5 text-[10px] text-gray-400 text-center leading-none">
          Sends via VoIP.ms · MMS charges may apply for attachments
        </p>
      )}
    </div>
  )
}

