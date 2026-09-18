'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ChevronDown } from 'lucide-react'
import { refreshAccessToken } from '@/lib/auth/client'
import { smartMatch, scoreHaystack } from '@/lib/search/scoring'
import {
  Composer,
  MsgBubble,
  dateSep,
  normaliseTeamMsg,
  replyPreviewText,
  resolveMessageMediaUrl,
  type DraftMedia,
  type MsgAttachment,
  type NormalizedMsg,
  type ReactionEntry,
} from '@/components/messages/chat-ui'

// ─── Unified thread shape ──────────────────────────────────────────────────────

type UnifiedThread = {
  id: string
  kind: 'team' | 'sms'
  channel: 'team' | 'SMS' | 'MMS'
  title: string
  subtitle?: string | null
  phone?: string       // E.164
  phoneDisplay?: string
  unreadCount: number
  lastMessageAt: string | null
  preview: string | null
  previewIsOutbound?: boolean
  pinned: boolean
  convType: string     // TEAM / DM / JOB_THREAD / SMS / MMS
  jobId?: string | null
  jobNumber?: string | null
  jobTitle?: string | null
  threadTitle?: string | null
}

type UserRow = { id: string; firstName: string | null; lastName: string | null; email: string }

function initials(name: string) {
  const parts = name.trim().split(/\s+/)
  return parts.length >= 2 ? `${parts[0][0]}${parts[1][0]}`.toUpperCase() : (parts[0]?.[0] || '?').toUpperCase()
}

function relTime(iso: string) {
  const ms = Date.now() - new Date(iso).getTime()
  const m = Math.floor(ms / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d`
  const dt = new Date(iso)
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// Convert a raw SMS Message to NormalizedMsg
function normaliseSmsMsg(raw: any): NormalizedMsg {
  const mediaArr: any[] = raw.media || []
  const atts: MsgAttachment[] = mediaArr.map((m: any): MsgAttachment => {
    const mime = String(m.mimeType || '')
    const type = String(m.type || '')
    const kind: MsgAttachment['kind'] =
      mime.startsWith('image/') || type === 'image' ? 'IMAGE'
      : mime.startsWith('video/') || type === 'video' ? 'VIDEO'
      : mime.startsWith('audio/') || type === 'audio' ? 'AUDIO'
      : 'FILE'
    return {
      kind,
      url: resolveMessageMediaUrl(typeof m.url === 'string' ? m.url : ''),
      fileName: m.filename || null,
      mimeType: m.mimeType || null,
    }
  })
  return {
    id: raw.id,
    isMine: raw.direction === 'OUTBOUND',
    text: raw.body || null,
    createdAt: raw.createdAt,
    status: raw.status,
    attachments: atts,
    replyTo: null,
    reactions: [],
    canInteract: false, // reply/react are not yet supported on the SMS/MMS backend
  }
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function ThreadBadge({ kind, convType }: { kind: 'team' | 'sms'; convType: string }) {
  if (kind === 'sms') {
    return (
      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-wide bg-emerald-50 text-emerald-600 border border-emerald-100">
        {convType === 'MMS' ? 'MMS' : 'SMS'}
      </span>
    )
  }
  if (convType === 'DM') {
    return (
      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-wide bg-blue-50 text-blue-500 border border-blue-100">
        DM
      </span>
    )
  }
  if (convType === 'JOB_THREAD') {
    return (
      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-wide bg-amber-50 text-amber-600 border border-amber-100">
        JOB
      </span>
    )
  }
  return null
}

function AvatarCircle({ label, color }: { label: string; color: 'blue' | 'emerald' | 'violet' | 'gray' | 'amber' }) {
  const cls =
    color === 'emerald' ? 'bg-emerald-50 text-emerald-600 ring-emerald-100'
    : color === 'violet' ? 'bg-violet-50 text-violet-600 ring-violet-100'
    : color === 'amber' ? 'bg-amber-50 text-amber-600 ring-amber-100'
    : color === 'gray' ? 'bg-gray-100 text-gray-500 ring-gray-200'
    : 'bg-blue-50 text-blue-600 ring-blue-100'
  return (
    <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 text-sm font-semibold ring-1 ${cls}`}>
      {initials(label)}
    </div>
  )
}


// ─── Main page ────────────────────────────────────────────────────────────────

export default function MessagesPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const deepLinkConversationId = searchParams.get('conversationId')
  const [myId, setMyId] = useState('')
  const [threads, setThreads] = useState<UnifiedThread[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(deepLinkConversationId)
  const [messages, setMessages] = useState<NormalizedMsg[]>([])
  const [threadsLoading, setThreadsLoading] = useState(true)
  const [msgsLoading, setMsgsLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [channelFilter, setChannelFilter] = useState<'all' | 'sms' | 'dm' | 'job'>('all')
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)

  // Reply / reaction state (internal team / DM / job threads)
  const [replyTarget, setReplyTarget] = useState<NormalizedMsg | null>(null)
  const [highlightedId, setHighlightedId] = useState<string | null>(null)

  // New chat modal state
  const [newOpen, setNewOpen] = useState(false)
  const [newType, setNewType] = useState<'team' | 'sms'>('team')
  const [newUsers, setNewUsers] = useState<UserRow[]>([])
  const [newUserFilter, setNewUserFilter] = useState('')
  const [newUserId, setNewUserId] = useState('')
  const [newPhone, setNewPhone] = useState('')
  const [creating, setCreating] = useState(false)

  const bottomRef = useRef<HTMLDivElement | null>(null)
  const scrollAreaRef = useRef<HTMLDivElement | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastMessageKeyRef = useRef<string | null>(null)
  const prevSelectedIdRef = useRef<string | null>(null)

  const selectedThread = useMemo(() => threads.find((t) => t.id === selectedId) ?? null, [threads, selectedId])

  // ── Auth helper ────────────────────────────────────────────────────────────
  const fetchAuth = useCallback(async (url: string, init?: RequestInit) => {
    let token = localStorage.getItem('accessToken')
    if (!token) {
      if (!await refreshAccessToken()) { router.push('/auth/login'); throw new Error('unauth') }
      token = localStorage.getItem('accessToken')
    }
    let res = await fetch(url, { ...init, headers: { ...(init?.headers || {}), Authorization: `Bearer ${token}` } })
    if (res.status === 401) {
      if (!await refreshAccessToken()) { router.push('/auth/login'); throw new Error('unauth') }
      token = localStorage.getItem('accessToken')
      res = await fetch(url, { ...init, headers: { ...(init?.headers || {}), Authorization: `Bearer ${token}` } })
    }
    return res
  }, [router])

  // ── Bootstrap ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const token = localStorage.getItem('accessToken') || ''
    const parts = token.split('.')
    if (parts.length >= 2) {
      try { const p = JSON.parse(atob(parts[1])); if (p?.userId) setMyId(String(p.userId)) } catch {}
    }
  }, [])

  // ── Load threads ───────────────────────────────────────────────────────────
  const loadThreads = useCallback(async (selectFirst = false) => {
    // Ensure team conversation exists for this user
    fetchAuth('/api/messages/team/ensure', { method: 'POST' }).catch(() => {})
    const res = await fetchAuth('/api/messages/unified')
    if (!res.ok) return
    const data = await res.json()
    const list: UnifiedThread[] = data.threads || []
    setThreads(list)
    if (selectFirst && !selectedId && list.length > 0) setSelectedId(list[0].id)
  }, [fetchAuth, selectedId])

  useEffect(() => {
    if (!deepLinkConversationId) return
    setSelectedId(deepLinkConversationId)
  }, [deepLinkConversationId])

  useEffect(() => {
    setThreadsLoading(true)
    loadThreads(true).finally(() => setThreadsLoading(false))
  }, [])

  // ── Load messages for selected thread ──────────────────────────────────────
  // `silent` skips the loading placeholder — used for background polling/SSE
  // refreshes so the list doesn't flicker to "Loading messages…" and back
  // every few seconds; only the initial load of a thread shows it.
  const loadMessages = useCallback(async (thread: UnifiedThread, opts?: { silent?: boolean }) => {
    if (!opts?.silent) setMsgsLoading(true)
    try {
      if (thread.kind === 'team') {
        const res = await fetchAuth(`/api/messages/conversations/${thread.id}/messages?limit=80`)
        if (!res.ok) return
        const data = await res.json()
        const rawMsgs: any[] = (data.messages || []).reverse()
        setMessages(rawMsgs.map((m) => normaliseTeamMsg(m, myId)))
        // Mark read
        fetchAuth(`/api/messages/conversations/${thread.id}/read`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        }).catch(() => {})
      } else {
        const res = await fetchAuth(`/api/sms/conversations/${thread.id}/messages`)
        if (!res.ok) return
        const data = await res.json()
        setMessages((data.messages || []).map(normaliseSmsMsg))
      }
    } finally {
      setMsgsLoading(false)
    }
  }, [fetchAuth, myId])

  useEffect(() => {
    if (!selectedThread) return
    loadMessages(selectedThread)
  }, [selectedId]) // eslint-disable-line

  // Clear any pending reply / jump-highlight when switching threads
  useEffect(() => {
    setReplyTarget(null)
    setHighlightedId(null)
  }, [selectedId])

  const jumpToMessage = useCallback((messageId: string) => {
    const el = document.getElementById(`msg-${messageId}`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setHighlightedId(messageId)
    window.setTimeout(() => setHighlightedId((cur) => (cur === messageId ? null : cur)), 1600)
  }, [])

  const handleReply = useCallback((msg: NormalizedMsg) => {
    if (!msg.canInteract) return
    setReplyTarget(msg)
  }, [])

  const handleToggleReaction = useCallback(async (messageId: string, emoji: string) => {
    if (!selectedThread || selectedThread.kind !== 'team') return
    try {
      const res = await fetchAuth(`/api/messages/conversations/${selectedThread.id}/messages/${messageId}/react`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji }),
      })
      if (!res.ok) return
      const data = await res.json()
      const reactions: ReactionEntry[] = data.reactions || []
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, reactions } : m)))
    } catch {
      /* best-effort; UI will resync on next poll/SSE update */
    }
  }, [selectedThread, fetchAuth])

  const handleDelete = useCallback(async (msg: NormalizedMsg) => {
    if (!selectedThread || selectedThread.kind !== 'team' || !msg.isMine) return
    if (!window.confirm('Delete this message for everyone?')) return
    try {
      const res = await fetchAuth(`/api/messages/conversations/${selectedThread.id}/messages/${msg.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'EVERYONE' }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        alert(data.error || 'Failed to delete message')
        return
      }
      setMessages((prev) => prev.filter((m) => m.id !== msg.id))
      if (replyTarget?.id === msg.id) setReplyTarget(null)
    } catch {
      alert('Failed to delete message')
    }
  }, [selectedThread, fetchAuth, replyTarget])

  // ── SSE for team chats ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!selectedThread || selectedThread.kind !== 'team') return
    const token = localStorage.getItem('accessToken')
    if (!token) return
    const src = new EventSource(`/api/messages/stream?token=${encodeURIComponent(token)}&since=${encodeURIComponent(new Date().toISOString())}`)
    src.addEventListener('new_message', async (e) => {
      const p = JSON.parse((e as MessageEvent).data)
      if (p.conversationId === selectedId) await loadMessages(selectedThread, { silent: true })
      loadThreads()
    })
    return () => src.close()
  }, [selectedId]) // eslint-disable-line

  // ── Poll SMS threads ───────────────────────────────────────────────────────
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current)
    if (!selectedThread || selectedThread.kind !== 'sms') return
    pollRef.current = setInterval(() => {
      loadMessages(selectedThread, { silent: true })
      loadThreads()
    }, 5000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [selectedId]) // eslint-disable-line

  // ── Scroll bottom ──────────────────────────────────────────────────────────
  // Only auto-scroll when a message actually arrived/changed (polling/SSE
  // otherwise re-sets the array every few seconds with identical content,
  // which was yanking the view back to the bottom while reading history) and
  // only if the user is already near the bottom, so scrolling up to read
  // stays put through background refreshes.
  useEffect(() => {
    const last = messages[messages.length - 1]
    const key = last ? last.id : null
    const threadChanged = prevSelectedIdRef.current !== selectedId
    const hasNewMessage = key !== null && key !== lastMessageKeyRef.current
    prevSelectedIdRef.current = selectedId
    lastMessageKeyRef.current = key

    if (!threadChanged && !hasNewMessage) return

    const container = scrollAreaRef.current
    const nearBottom = threadChanged || !container || container.scrollHeight - container.scrollTop - container.clientHeight < 150
    if (nearBottom) {
      bottomRef.current?.scrollIntoView({ behavior: threadChanged ? 'auto' : 'smooth' })
      setShowScrollToBottom(false)
    } else {
      setShowScrollToBottom(true)
    }
  }, [messages, selectedId])

  // Track manual scroll position so the "jump to bottom" button only shows
  // once the user has actually scrolled away from the latest message.
  const handleMessagesScroll = useCallback(() => {
    const container = scrollAreaRef.current
    if (!container) return
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
    setShowScrollToBottom(distanceFromBottom > 150)
  }, [])

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    setShowScrollToBottom(false)
  }, [])

  // ── Send message ───────────────────────────────────────────────────────────
  const handleSend = useCallback(async (text: string, media: DraftMedia[], durationMs?: number) => {
    if (!selectedThread) return
    if (selectedThread.kind === 'team') {
      const attachments = media.map((m) => ({
        kind: m.type === 'audio' ? 'VOICE' : m.type === 'image' ? 'IMAGE' : m.type === 'video' ? 'VIDEO' : 'FILE',
        url: m.url,
        fileName: m.filename,
        mimeType: m.mimeType,
        durationMs: durationMs || null,
      }))
      const res = await fetchAuth(`/api/messages/conversations/${selectedThread.id}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: text || null,
          clientTempId: `web-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          attachments,
          replyToMessageId: replyTarget?.id || null,
          replyToSenderName: replyTarget ? (replyTarget.isMine ? 'You' : (replyTarget.senderName || 'Unknown')) : null,
          replyToText: replyTarget ? replyPreviewText(replyTarget) : null,
          replyToType: replyTarget
            ? (replyTarget.attachments.length === 0 ? 'TEXT'
              : replyTarget.attachments[0].kind === 'AUDIO' ? 'VOICE'
              : replyTarget.attachments[0].kind === 'LOCATION' ? 'LOCATION'
              : 'MEDIA')
            : null,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        alert(err.error || `Failed to send message (${res.status})`)
        return
      }
      setReplyTarget(null)
    } else {
      // SMS / MMS
      const mediaPayload = media.map((m) => ({
        url: m.url, type: m.type, mimeType: m.mimeType, filename: m.filename,
      }))
      const res = await fetchAuth(`/api/sms/conversations/${selectedThread.id}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text || undefined, media: mediaPayload.length > 0 ? mediaPayload : undefined }),
      })
      const data = await res.json()
      if (!res.ok) { alert(data.error || 'Failed to send'); return }
    }
    await loadMessages(selectedThread, { silent: true })
    await loadThreads()
  }, [selectedThread, fetchAuth, loadMessages, loadThreads, replyTarget])

  // ── New chat ───────────────────────────────────────────────────────────────
  const openNewChat = async () => {
    if (!newUsers.length) {
      const res = await fetchAuth('/api/messages/users')
      if (res.ok) { const d = await res.json(); setNewUsers(d.users || []) }
    }
    setNewOpen(true)
  }

  const filteredUsers = useMemo(() => {
    const q = newUserFilter.trim()
    if (!q) return newUsers
    return [...newUsers]
      .filter((u) => smartMatch(q, [u.firstName, u.lastName, u.email]))
      .sort(
        (a, b) =>
          scoreHaystack(q, [`${b.firstName} ${b.lastName}`, b.email], []) -
          scoreHaystack(q, [`${a.firstName} ${a.lastName}`, a.email], [])
      )
  }, [newUsers, newUserFilter])

  const createNewChat = async () => {
    setCreating(true)
    try {
      if (newType === 'team') {
        if (!newUserId) return
        const res = await fetchAuth('/api/messages/dm', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: newUserId }),
        })
        if (!res.ok) return
        const d = await res.json()
        await loadThreads()
        setSelectedId(d.conversationId)
      } else {
        const phone = newPhone.trim()
        if (!phone) return
        const res = await fetchAuth('/api/sms/conversations', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone }),
        })
        if (!res.ok) { alert('Failed to start SMS conversation'); return }
        const d = await res.json()
        await loadThreads()
        setSelectedId(d.conversationId)
      }
      setNewOpen(false); setNewUserId(''); setNewPhone(''); setNewUserFilter('')
    } finally { setCreating(false) }
  }

  // ── Filtered thread list ───────────────────────────────────────────────────
  const channelFiltered = useMemo(() => {
    if (channelFilter === 'all') return threads
    if (channelFilter === 'sms') return threads.filter((t) => t.kind === 'sms')
    if (channelFilter === 'job') return threads.filter((t) => t.convType === 'JOB_THREAD')
    // 'dm' — internal team/DM threads that aren't job threads
    return threads.filter((t) => t.kind === 'team' && t.convType !== 'JOB_THREAD')
  }, [threads, channelFilter])

  const filteredThreads = useMemo(() => {
    const q = search.trim()
    if (!q) return channelFiltered
    return channelFiltered.filter((t) =>
      smartMatch(q, [t.title, t.subtitle, t.phoneDisplay, t.phone, t.preview, t.jobNumber, t.jobTitle, t.threadTitle])
    )
  }, [channelFiltered, search])

  const sidebarGroups = useMemo(() => {
    const regular = filteredThreads.filter((thread) => thread.convType !== 'JOB_THREAD')
    const jobs = new Map<string, UnifiedThread[]>()
    for (const thread of filteredThreads) {
      if (thread.convType !== 'JOB_THREAD') continue
      const key = thread.jobId || thread.id
      jobs.set(key, [...(jobs.get(key) || []), thread])
    }
    return { regular, jobs: Array.from(jobs.values()) }
  }, [filteredThreads])

  // ── Avatar color by kind ───────────────────────────────────────────────────
  function threadAvatarColor(t: UnifiedThread): 'blue' | 'emerald' | 'violet' | 'gray' | 'amber' {
    if (t.kind === 'sms') return 'emerald'
    if (t.convType === 'TEAM') return 'emerald'
    if (t.convType === 'JOB_THREAD') return 'amber'
    return 'blue'
  }

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full bg-[#f0f2f5] overflow-hidden">

      {/* ── Sidebar ─────────────────────────────────────────────────────────── */}
      <aside className="w-[320px] flex-shrink-0 border-r border-gray-200 bg-white flex flex-col">

        {/* Header */}
        <div className="px-4 py-3.5 border-b border-gray-100 bg-[#f0f2f5]">
          <div className="flex items-center justify-between mb-3">
            <h1 className="text-base font-bold text-gray-900">Messages</h1>
            <button
              onClick={openNewChat}
              className="w-8 h-8 rounded-full bg-[#00a884] hover:bg-[#008f72] flex items-center justify-center text-white transition-colors shadow-sm"
              title="New conversation"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
            </button>
          </div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search conversations…"
            className="w-full h-9 px-3 rounded-lg bg-white border border-gray-200 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/15"
          />
          <div className="flex items-center gap-1.5 mt-2">
            {([
              { key: 'all', label: 'All' },
              { key: 'sms', label: 'SMS' },
              { key: 'dm', label: 'DM' },
              { key: 'job', label: 'Job' },
            ] as const).map((opt) => (
              <button
                key={opt.key}
                onClick={() => setChannelFilter(opt.key)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                  channelFilter === opt.key
                    ? 'bg-[#00a884] text-white'
                    : 'bg-white text-gray-500 border border-gray-200 hover:bg-gray-50'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Thread list */}
        <div className="flex-1 overflow-y-auto">
          {threadsLoading ? (
            <div className="pt-12 text-center text-sm text-gray-400">Loading…</div>
          ) : filteredThreads.length === 0 ? (
            <div className="pt-12 text-center text-sm text-gray-400">No conversations yet</div>
          ) : (
            <>
              {sidebarGroups.regular.map((t) => (
              <button
                key={t.id}
                onClick={() => setSelectedId(t.id)}
                className={`w-full text-left px-4 py-3 flex items-start gap-3 border-b border-gray-100 transition-colors ${
                  selectedId === t.id ? 'bg-[#f0f2f5]' : 'hover:bg-[#f5f6f6]'
                }`}
              >
                <AvatarCircle label={t.title} color={threadAvatarColor(t)} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-1 mb-0.5">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className={`text-sm truncate ${t.unreadCount > 0 ? 'font-semibold text-gray-900' : 'font-medium text-gray-700'}`}>
                        {t.title}
                      </span>
                      <ThreadBadge kind={t.kind} convType={t.convType} />
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {t.lastMessageAt && (
                        <span className={`text-[10px] ${t.unreadCount > 0 ? 'text-[#00a884] font-semibold' : 'text-gray-400'}`}>{relTime(t.lastMessageAt)}</span>
                      )}
                    </div>
                  </div>
                  {t.subtitle && <div className="text-[11px] text-gray-400 mb-0.5">{t.subtitle}</div>}
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-400 truncate flex-1">
                      {t.previewIsOutbound ? '→ ' : ''}{t.preview || 'No messages'}
                    </span>
                    {t.unreadCount > 0 && (
                      <span className="min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold bg-[#25d366] text-white flex items-center justify-center">
                        {t.unreadCount > 99 ? '99+' : t.unreadCount}
                      </span>
                    )}
                  </div>
                </div>
              </button>
              ))}
              {sidebarGroups.jobs.map((jobThreads) => {
                const job = jobThreads[0]
                const jobLabel = `Job ${job.jobNumber || ''}${job.jobTitle ? ` — ${job.jobTitle}` : ''}`.trim()
                const unreadCount = jobThreads.reduce((sum, thread) => sum + thread.unreadCount, 0)
                return (
                  <div key={job.jobId || job.id} className="border-b border-gray-100">
                    <div className="px-4 pt-3 pb-1.5 flex items-center gap-2 bg-amber-50/40">
                      <svg className="w-4 h-4 text-amber-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7h-4V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2H4a2 2 0 00-2 2v9a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2zM10 5h4v2h-4V5z" /></svg>
                      <span className="text-xs font-semibold text-amber-900 truncate flex-1">{jobLabel}</span>
                      {unreadCount > 0 && (
                        <span className="min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold bg-[#25d366] text-white flex items-center justify-center">
                          {unreadCount > 99 ? '99+' : unreadCount}
                        </span>
                      )}
                    </div>
                    {jobThreads.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => setSelectedId(t.id)}
                        className={`w-full text-left pl-8 pr-4 py-2.5 flex items-start gap-3 transition-colors ${
                          selectedId === t.id ? 'bg-amber-50' : 'hover:bg-gray-50'
                        }`}
                      >
                        <AvatarCircle label={t.threadTitle || t.subtitle || 'General'} color="amber" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-1 mb-0.5">
                            <span className={`text-sm truncate ${t.unreadCount > 0 ? 'font-semibold text-gray-900' : 'font-medium text-gray-700'}`}>
                              {t.threadTitle || t.subtitle || 'General'}
                            </span>
                            {t.lastMessageAt && <span className={`text-[10px] ${t.unreadCount > 0 ? 'text-[#00a884] font-semibold' : 'text-gray-400'}`}>{relTime(t.lastMessageAt)}</span>}
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-gray-400 truncate flex-1">
                              {t.previewIsOutbound ? '→ ' : ''}{t.preview || 'No messages'}
                            </span>
                            {t.unreadCount > 0 && (
                              <span className="min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold bg-[#25d366] text-white flex items-center justify-center">
                                {t.unreadCount > 99 ? '99+' : t.unreadCount}
                              </span>
                            )}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )
              })}
            </>
          )}
        </div>
      </aside>

      {/* ── Thread pane ─────────────────────────────────────────────────────── */}
      <section className="flex-1 flex flex-col min-w-0" style={{ backgroundColor: '#efeae2' }}>
        {!selectedThread ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-gray-500 select-none">
              <div className="text-5xl mb-3 opacity-30">💬</div>
              <div className="text-sm font-medium text-gray-500">Select a conversation</div>
              <button
                onClick={openNewChat}
                className="mt-3 text-xs text-[#25d366] hover:text-[#1ebe57] underline underline-offset-2"
              >
                or start a new one
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Thread header */}
            <header className="h-14 px-5 bg-[#f0f2f5] border-b border-black/5 flex items-center gap-3 flex-shrink-0">
              <AvatarCircle label={selectedThread.title} color={threadAvatarColor(selectedThread)} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-[#111b21] text-sm truncate">{selectedThread.title}</span>
                  <ThreadBadge kind={selectedThread.kind} convType={selectedThread.convType} />
                </div>
                <div className="text-xs text-[#667781] truncate">
                  {selectedThread.kind === 'sms'
                    ? (selectedThread.subtitle || selectedThread.phoneDisplay || 'SMS conversation')
                    : selectedThread.convType === 'TEAM' ? 'Team · all members'
                    : selectedThread.convType === 'JOB_THREAD' ? 'Job thread · assigned crew & office'
                    : 'Direct message'
                  }
                </div>
              </div>
              {selectedThread.convType === 'JOB_THREAD' && selectedThread.jobId && (
                <a
                  href={`/dashboard/jobs/${selectedThread.jobId}`}
                  className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-amber-50 text-amber-700 border border-amber-100 hover:bg-amber-100 transition-colors"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                  View Job
                </a>
              )}
            </header>

            {/* Messages */}
            <div className="relative flex-1 min-h-0">
            <div
              ref={scrollAreaRef}
              onScroll={handleMessagesScroll}
              className="absolute inset-0 overflow-y-auto px-5 py-5 flex flex-col gap-1"
              style={{ backgroundImage: 'radial-gradient(rgba(0,0,0,0.03) 1px, transparent 1px)', backgroundSize: '18px 18px' }}
            >
              {msgsLoading ? (
                <div className="flex-1 flex items-center justify-center">
                  <div className="text-sm text-gray-400">Loading messages…</div>
                </div>
              ) : messages.length === 0 ? (
                <div className="flex-1 flex items-center justify-center">
                  <div className="text-center text-gray-400">
                    <div className="text-3xl mb-2 opacity-30">👋</div>
                    <div className="text-sm">No messages yet. Say hello!</div>
                  </div>
                </div>
              ) : (
                messages.map((msg, i) => {
                  const prev = i > 0 ? messages[i - 1] : null
                  const showDate = !prev || new Date(msg.createdAt).toDateString() !== new Date(prev.createdAt).toDateString()
                  // Group consecutive same-sender messages
                  const next = i < messages.length - 1 ? messages[i + 1] : null
                  const isLastInGroup = !next || next.isMine !== msg.isMine
                  const showName =
                    !msg.isMine &&
                    (selectedThread.convType === 'TEAM' || selectedThread.convType === 'JOB_THREAD') &&
                    (!prev || prev.isMine !== msg.isMine)

                  return (
                    <React.Fragment key={msg.id}>
                      {showDate && (
                        <div className="flex justify-center my-3">
                          <span className="text-[11px] text-[#54656f] font-medium px-3 py-1 rounded-lg bg-white/90 shadow-sm border border-black/5">{dateSep(msg.createdAt)}</span>
                        </div>
                      )}
                      <div className={isLastInGroup ? 'mb-2' : 'mb-0.5'}>
                        <MsgBubble
                          msg={msg}
                          showSenderName={showName}
                          showJobLink={selectedThread.convType !== 'JOB_THREAD'}
                          myId={myId}
                          isHighlighted={highlightedId === msg.id}
                          onReply={handleReply}
                          onToggleReaction={handleToggleReaction}
                          onJumpTo={jumpToMessage}
                          onDelete={selectedThread.kind === 'team' ? handleDelete : undefined}
                        />
                      </div>
                    </React.Fragment>
                  )
                })
              )}
              <div ref={bottomRef} />
            </div>
            {showScrollToBottom && (
              <button
                onClick={scrollToBottom}
                title="Scroll to latest"
                className="absolute bottom-4 right-4 w-10 h-10 rounded-full bg-white shadow-lg border border-gray-200 flex items-center justify-center text-gray-600 hover:bg-gray-50 transition-colors"
              >
                <ChevronDown className="h-5 w-5" />
              </button>
            )}
            </div>

            {/* Composer */}
            <Composer
              isSms={selectedThread.kind === 'sms'}
              onSend={handleSend}
              replyPreview={
                replyTarget
                  ? { senderName: replyTarget.isMine ? 'You' : (replyTarget.senderName || 'Unknown'), textPreview: replyPreviewText(replyTarget) }
                  : null
              }
              onClearReply={() => setReplyTarget(null)}
            />
          </>
        )}
      </section>

      {/* ── New conversation modal ──────────────────────────────────────────── */}
      {newOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setNewOpen(false)} />
          <div className="relative w-[380px] bg-white rounded-2xl shadow-xl p-6 z-10">
            <h2 className="text-base font-bold text-gray-900 mb-4">New Conversation</h2>

            {/* Type selector */}
            <div className="flex gap-2 mb-5">
              {(['team', 'sms'] as const).map((type) => (
                <button
                  key={type}
                  onClick={() => setNewType(type)}
                  className={`flex-1 py-2 rounded-xl text-sm font-medium transition-colors border ${
                    newType === type
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  {type === 'team' ? '👥 Team / DM' : '📱 SMS'}
                </button>
              ))}
            </div>

            {newType === 'team' ? (
              <div className="space-y-3">
                <input
                  value={newUserFilter}
                  onChange={(e) => setNewUserFilter(e.target.value)}
                  placeholder="Search team members…"
                  className="w-full h-9 px-3 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 bg-gray-50"
                />
                <div className="max-h-44 overflow-y-auto rounded-xl border border-gray-100 divide-y divide-gray-50">
                  {filteredUsers.length === 0 ? (
                    <div className="py-6 text-center text-sm text-gray-400">No users found</div>
                  ) : filteredUsers.map((u) => (
                    <button
                      key={u.id}
                      onClick={() => setNewUserId(u.id)}
                      className={`w-full text-left px-3 py-2.5 flex items-center gap-2.5 transition-colors ${
                        newUserId === u.id ? 'bg-blue-50' : 'hover:bg-gray-50'
                      }`}
                    >
                      <div className="w-7 h-7 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center text-xs font-semibold">
                        {initials(`${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email)}
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-gray-800 truncate">
                          {`${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email}
                        </div>
                        {(u.firstName || u.lastName) && <div className="text-xs text-gray-400 truncate">{u.email}</div>}
                      </div>
                      {newUserId === u.id && <svg className="w-4 h-4 text-blue-600 ml-auto flex-shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1.5">Phone Number</label>
                <input
                  value={newPhone}
                  onChange={(e) => setNewPhone(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') createNewChat() }}
                  placeholder="(845) 782-1617"
                  className="w-full h-10 px-3 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 bg-gray-50"
                  autoFocus
                />
                <p className="mt-1.5 text-xs text-gray-400">E.g. 845-782-1617 or +18457821617</p>
              </div>
            )}

            <div className="flex gap-2 mt-5">
              <button
                onClick={() => { setNewOpen(false); setNewUserId(''); setNewPhone(''); setNewUserFilter('') }}
                className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={createNewChat}
                disabled={creating || (newType === 'team' ? !newUserId : !newPhone.trim())}
                className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm font-medium transition-colors"
              >
                {creating ? 'Opening…' : 'Start Chat'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
