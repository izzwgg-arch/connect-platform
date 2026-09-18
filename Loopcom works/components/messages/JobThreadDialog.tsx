'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { refreshAccessToken } from '@/lib/auth/client'
import {
  Composer,
  MsgBubble,
  dateSep,
  normaliseTeamMsg,
  replyPreviewText,
  type DraftMedia,
  type NormalizedMsg,
  type ReactionEntry,
} from '@/components/messages/chat-ui'

type Recipient = {
  id: string
  firstName: string | null
  lastName: string | null
  email: string
  role: string
  isAssignee: boolean
}

type JobThread = {
  id: string
  title: string | null
  lastMessageAt: string | null
  createdAt: string
}

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  jobId: string
  jobNumber?: string | null
}

function recipientLabel(r: Recipient) {
  return `${r.firstName || ''} ${r.lastName || ''}`.trim() || r.email
}

function threadLabel(t: JobThread) {
  const title = (t.title || '').trim()
  if (title) return title
  return 'General'
}

function recipientsStorageKey(jobId: string) {
  return `trimpro.jobChat.recipients.${jobId}`
}

function loadSavedRecipientIds(jobId: string): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.sessionStorage.getItem(recipientsStorageKey(jobId))
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string' && id) : []
  } catch {
    return []
  }
}

function saveRecipientIds(jobId: string, ids: string[]) {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(recipientsStorageKey(jobId), JSON.stringify(ids))
  } catch {
    /* ignore */
  }
}

/**
 * Full job chat popup: left thread list, right chat pane, sticky recipients.
 */
export function JobThreadDialog({ open, onOpenChange, jobId, jobNumber }: Props) {
  const router = useRouter()
  const [myId, setMyId] = useState('')
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [threads, setThreads] = useState<JobThread[]>([])
  const [messages, setMessages] = useState<NormalizedMsg[]>([])
  const [recipients, setRecipients] = useState<Recipient[]>([])
  const [selectedRecipientIds, setSelectedRecipientIds] = useState<string[]>([])
  const [recipientsLocked, setRecipientsLocked] = useState(false)
  const [loading, setLoading] = useState(false)
  const [msgsLoading, setMsgsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [replyTarget, setReplyTarget] = useState<NormalizedMsg | null>(null)
  const [highlightedId, setHighlightedId] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [newThreadOpen, setNewThreadOpen] = useState(false)
  const [newThreadTitle, setNewThreadTitle] = useState('')
  const [creatingThread, setCreatingThread] = useState(false)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const selectionTouchedRef = useRef(false)

  const fetchAuth = useCallback(async (url: string, init?: RequestInit) => {
    let token = localStorage.getItem('accessToken')
    if (!token) {
      if (!(await refreshAccessToken())) {
        router.push('/auth/login')
        throw new Error('unauthenticated')
      }
      token = localStorage.getItem('accessToken')
    }
    const withAuth = (authToken: string | null): RequestInit => ({
      ...init,
      headers: {
        ...(init?.headers || {}),
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
    })
    let res = await fetch(url, withAuth(token))
    if (res.status === 401) {
      if (!(await refreshAccessToken())) {
        router.push('/auth/login')
        throw new Error('unauthenticated')
      }
      token = localStorage.getItem('accessToken')
      res = await fetch(url, withAuth(token))
    }
    return res
  }, [router])

  useEffect(() => {
    const token = localStorage.getItem('accessToken') || ''
    const parts = token.split('.')
    if (parts.length >= 2) {
      try {
        const p = JSON.parse(atob(parts[1]))
        if (p?.userId) setMyId(String(p.userId))
      } catch {
        /* ignore */
      }
    }
  }, [])

  const loadMessages = useCallback(
    async (id: string, uid: string) => {
      setMsgsLoading(true)
      try {
        const res = await fetchAuth(`/api/messages/conversations/${id}/messages?limit=80`)
        if (!res.ok) return
        const data = await res.json()
        const raw: any[] = (data.messages || []).reverse()
        setMessages(raw.map((m) => normaliseTeamMsg(m, uid)))
        fetchAuth(`/api/messages/conversations/${id}/read`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        }).catch(() => {})
      } finally {
        setMsgsLoading(false)
      }
    },
    [fetchAuth]
  )

  const applyEnsurePayload = useCallback(
    async (data: any, uid: string) => {
      const id = data.conversationId as string
      const list: Recipient[] = Array.isArray(data.recipients) ? data.recipients : []
      const threadList: JobThread[] = Array.isArray(data.threads) ? data.threads : []
      setConversationId(id)
      setRecipients(list)
      setThreads(threadList)

      const allowed = new Set(list.map((r) => r.id).filter((rid) => rid !== uid))
      setSelectedRecipientIds((prev) => {
        const candidates = [...prev, ...loadSavedRecipientIds(jobId)]
        const next = Array.from(new Set(candidates)).filter((rid) => allowed.has(rid))
        if (next.length > 0) {
          setRecipientsLocked(true)
          selectionTouchedRef.current = true
          saveRecipientIds(jobId, next)
        }
        return next
      })

      if (id) await loadMessages(id, uid)
    },
    [jobId, loadMessages]
  )

  const ensureThread = useCallback(
    async (opts?: { title?: string; conversationId?: string }) => {
      const res = await fetchAuth('/api/messages/job/ensure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId,
          title: opts?.title,
          conversationId: opts?.conversationId,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(typeof data?.error === 'string' ? data.error : 'Failed to open job chat')
      }
      return data
    },
    [fetchAuth, jobId]
  )

  useEffect(() => {
    if (!open || !jobId || !myId) return
    let cancelled = false
    selectionTouchedRef.current = loadSavedRecipientIds(jobId).length > 0
    ;(async () => {
      setLoading(true)
      setError(null)
      try {
        const data = await ensureThread()
        if (cancelled) return
        await applyEnsurePayload(data, myId)
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Failed to open job chat')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, jobId, myId, ensureThread, applyEnsurePayload])

  useEffect(() => {
    if (!open) {
      setConversationId(null)
      setMessages([])
      setThreads([])
      setReplyTarget(null)
      setError(null)
      setPickerOpen(false)
      setNewThreadOpen(false)
      setNewThreadTitle('')
      // Keep recipient selection sticky across reopen for this job (sessionStorage).
    }
  }, [open])

  useEffect(() => {
    if (!open || !conversationId || !myId) return
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(() => {
      loadMessages(conversationId, myId)
    }, 5000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [open, conversationId, myId, loadMessages])

  useEffect(() => {
    if (!open) return
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, open])

  useEffect(() => {
    if (!jobId) return
    saveRecipientIds(jobId, selectedRecipientIds)
  }, [jobId, selectedRecipientIds])

  const activeThread = useMemo(
    () => threads.find((t) => t.id === conversationId) || null,
    [threads, conversationId]
  )

  const selectedRecipients = useMemo(
    () => recipients.filter((r) => selectedRecipientIds.includes(r.id) && r.id !== myId),
    [recipients, selectedRecipientIds, myId]
  )

  const selectedSummary = useMemo(() => {
    if (selectedRecipients.length === 0) return 'Select who receives messages'
    if (selectedRecipients.length <= 2) return selectedRecipients.map(recipientLabel).join(', ')
    return `${selectedRecipients.length} people selected`
  }, [selectedRecipients])

  const setSelection = (ids: string[]) => {
    selectionTouchedRef.current = true
    setRecipientsLocked(ids.length > 0)
    setSelectedRecipientIds(ids)
    saveRecipientIds(jobId, ids)
  }

  const toggleRecipient = (id: string) => {
    const next = selectedRecipientIds.includes(id)
      ? selectedRecipientIds.filter((x) => x !== id)
      : [...selectedRecipientIds, id]
    setSelection(next.filter((rid) => rid !== myId))
  }

  const selectAllRecipients = () => {
    setSelection(recipients.map((r) => r.id).filter((id) => id !== myId))
  }

  const clearRecipients = () => setSelection([])

  const switchThread = async (threadId: string) => {
    if (threadId === conversationId) return
    setLoading(true)
    setError(null)
    setReplyTarget(null)
    try {
      const data = await ensureThread({ conversationId: threadId })
      await applyEnsurePayload(data, myId)
    } catch (e: any) {
      setError(e?.message || 'Failed to switch thread')
    } finally {
      setLoading(false)
    }
  }

  const createThread = async () => {
    const title = newThreadTitle.trim()
    if (!title || creatingThread) return
    setCreatingThread(true)
    setError(null)
    try {
      const data = await ensureThread({ title })
      await applyEnsurePayload(data, myId)
      setNewThreadOpen(false)
      setNewThreadTitle('')
    } catch (e: any) {
      setError(e?.message || 'Failed to create thread')
    } finally {
      setCreatingThread(false)
    }
  }

  const handleReply = useCallback((msg: NormalizedMsg) => {
    if (!msg.canInteract) return
    setReplyTarget(msg)
  }, [])

  const jumpToMessage = useCallback((messageId: string) => {
    setHighlightedId(messageId)
    const el = document.getElementById(`msg-${messageId}`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    window.setTimeout(() => setHighlightedId((cur) => (cur === messageId ? null : cur)), 1600)
  }, [])

  const handleToggleReaction = useCallback(
    async (messageId: string, emoji: string) => {
      if (!conversationId) return
      try {
        const res = await fetchAuth(
          `/api/messages/conversations/${conversationId}/messages/${messageId}/react`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ emoji }),
          }
        )
        if (!res.ok) return
        const data = await res.json()
        const reactions: ReactionEntry[] = data.reactions || []
        setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, reactions } : m)))
      } catch {
        /* best-effort */
      }
    },
    [conversationId, fetchAuth]
  )

  const handleDelete = useCallback(
    async (msg: NormalizedMsg) => {
      if (!conversationId || !msg.isMine) return
      if (!window.confirm('Delete this message for everyone?')) return
      try {
        const res = await fetchAuth(`/api/messages/conversations/${conversationId}/messages/${msg.id}`, {
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
    },
    [conversationId, fetchAuth, replyTarget]
  )

  const handleSend = useCallback(
    async (text: string, media: DraftMedia[], durationMs?: number) => {
      if (!conversationId) return
      if (selectedRecipientIds.length === 0) {
        alert('Select at least one recipient. Messages only go to the people you pick.')
        setPickerOpen(true)
        return
      }

      const attachments = media.map((m) => {
        const kind =
          m.type === 'image' ? 'IMAGE'
          : m.type === 'video' ? 'VIDEO'
          : m.type === 'audio' ? 'VOICE'
          : 'FILE'
        return {
          kind,
          url: m.url,
          fileName: m.filename,
          mimeType: m.mimeType,
          durationMs: kind === 'VOICE' ? durationMs || null : null,
        }
      })

      const res = await fetchAuth(`/api/messages/conversations/${conversationId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: text || null,
          clientTempId: `job-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          // Always notify ONLY the selected recipients (sticky selection).
          notifyUserIds: selectedRecipientIds,
          replyToMessageId: replyTarget?.id || null,
          replyToSenderName: replyTarget
            ? replyTarget.isMine
              ? 'You'
              : replyTarget.senderName || 'Unknown'
            : null,
          replyToText: replyTarget ? replyPreviewText(replyTarget) : null,
          replyToType: replyTarget
            ? replyTarget.attachments.length === 0
              ? 'TEXT'
              : replyTarget.attachments[0].kind === 'AUDIO'
                ? 'VOICE'
                : replyTarget.attachments[0].kind === 'LOCATION'
                  ? 'LOCATION'
                  : replyTarget.attachments[0].kind
            : null,
          attachments,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        alert(data.error || 'Failed to send')
        return
      }
      setReplyTarget(null)
      setRecipientsLocked(true)
      await loadMessages(conversationId, myId)
    },
    [conversationId, fetchAuth, loadMessages, myId, replyTarget, selectedRecipientIds]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-5xl w-[min(96vw,1100px)] p-0 gap-0 overflow-hidden flex flex-col h-[min(92vh,880px)] max-h-[92vh] bg-[#f0f2f5]">
        <DialogHeader className="px-5 pt-4 pb-3 border-b border-black/5 space-y-1 bg-white shrink-0">
          <div className="flex items-start justify-between gap-3 pr-8">
            <div>
              <DialogTitle>{jobNumber ? `Job chat · ${jobNumber}` : 'Job chat'}</DialogTitle>
              <p className="text-xs text-muted-foreground font-normal mt-1">
                Threads on the left · chat on the right · messages only notify selected recipients
              </p>
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 min-h-0 flex">
          {/* Left: thread list */}
          <aside className="w-[240px] shrink-0 border-r border-black/5 bg-white flex flex-col">
            <div className="px-3 py-2 border-b border-black/5 flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-[#667781]">Threads</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                onClick={() => setNewThreadOpen((v) => !v)}
              >
                + New
              </Button>
            </div>

            {newThreadOpen && (
              <div className="px-3 py-2 border-b border-black/5 space-y-2 bg-[#f7f8fa]">
                <input
                  value={newThreadTitle}
                  onChange={(e) => setNewThreadTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void createThread()
                    }
                  }}
                  placeholder="Thread name"
                  className="w-full rounded-lg border px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                />
                <Button
                  type="button"
                  size="sm"
                  className="w-full h-8"
                  disabled={!newThreadTitle.trim() || creatingThread}
                  onClick={() => void createThread()}
                >
                  Create thread
                </Button>
              </div>
            )}

            <div className="flex-1 overflow-y-auto">
              {threads.length === 0 ? (
                <p className="px-3 py-6 text-xs text-muted-foreground text-center">No threads yet</p>
              ) : (
                threads.map((t) => {
                  const active = t.id === conversationId
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => void switchThread(t.id)}
                      className={`w-full text-left px-3 py-3 border-b border-black/5 transition-colors ${
                        active ? 'bg-[#d9fdd3]' : 'hover:bg-gray-50'
                      }`}
                    >
                      <div className={`text-sm truncate ${active ? 'font-semibold text-[#075e54]' : 'font-medium text-[#111b21]'}`}>
                        {threadLabel(t)}
                      </div>
                      <div className="text-[11px] text-[#667781] mt-0.5">
                        {t.lastMessageAt
                          ? new Date(t.lastMessageAt).toLocaleString([], {
                              month: 'short',
                              day: 'numeric',
                              hour: 'numeric',
                              minute: '2-digit',
                            })
                          : 'No messages'}
                      </div>
                    </button>
                  )
                })
              )}
            </div>
          </aside>

          {/* Right: chat */}
          <section className="flex-1 min-w-0 flex flex-col">
            <div className="px-4 py-2.5 bg-[#f0f2f5] border-b border-black/5 shrink-0 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-[#111b21] truncate">
                    {activeThread ? threadLabel(activeThread) : 'Select a thread'}
                  </div>
                  <div className="text-[11px] text-[#667781] truncate">
                    {recipientsLocked && selectedRecipients.length > 0
                      ? `Sending only to: ${selectedSummary}`
                      : 'Pick recipients below — selection stays until you change it'}
                  </div>
                </div>
              </div>

              <div className="relative">
                <button
                  type="button"
                  onClick={() => setPickerOpen((v) => !v)}
                  className="w-full flex items-center gap-2 rounded-xl border bg-white px-3 py-2 text-left text-sm hover:bg-gray-50 transition-colors"
                >
                  <span className="text-xs font-semibold text-[#008069] uppercase tracking-wide">To</span>
                  <span className="flex-1 truncate font-medium text-[#111b21]">{selectedSummary}</span>
                  <svg
                    className={`w-4 h-4 text-[#667781] transition-transform ${pickerOpen ? 'rotate-180' : ''}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {selectedRecipients.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {selectedRecipients.map((r) => (
                      <span
                        key={r.id}
                        className="inline-flex items-center gap-1 rounded-full bg-[#d9fdd3] text-[#075e54] px-2.5 py-1 text-[11px] font-medium"
                      >
                        {recipientLabel(r)}
                        <button
                          type="button"
                          className="opacity-70 hover:opacity-100"
                          onClick={() => toggleRecipient(r.id)}
                          aria-label={`Remove ${recipientLabel(r)}`}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}

                {pickerOpen && (
                  <div className="absolute z-30 left-0 right-0 mt-1 rounded-xl border bg-white shadow-lg max-h-56 overflow-y-auto">
                    <div className="sticky top-0 flex items-center gap-2 px-3 py-2 bg-white border-b text-xs">
                      <button type="button" className="text-[#008069] hover:underline" onClick={selectAllRecipients}>
                        Select all
                      </button>
                      <span className="text-muted-foreground">·</span>
                      <button type="button" className="text-[#008069] hover:underline" onClick={clearRecipients}>
                        Clear
                      </button>
                    </div>
                    {recipients.length === 0 ? (
                      <p className="px-3 py-4 text-sm text-muted-foreground">No recipients available</p>
                    ) : (
                      recipients
                        .filter((r) => r.id !== myId)
                        .map((r) => {
                          const checked = selectedRecipientIds.includes(r.id)
                          return (
                            <label
                              key={r.id}
                              className="flex items-center gap-3 px-3 py-2 hover:bg-gray-50 cursor-pointer text-sm"
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleRecipient(r.id)}
                                className="rounded border-gray-300"
                              />
                              <span className="flex-1 min-w-0">
                                <span className="font-medium block truncate">{recipientLabel(r)}</span>
                                <span className="text-[11px] text-muted-foreground">
                                  {r.isAssignee ? 'Assignee' : r.role}
                                </span>
                              </span>
                            </label>
                          )
                        })
                    )}
                  </div>
                )}
              </div>
            </div>

            <div
              className="flex-1 min-h-0 overflow-y-auto bg-[#efeae2] px-4 py-3 space-y-1"
              style={{
                backgroundImage: 'radial-gradient(rgba(0,0,0,0.03) 1px, transparent 1px)',
                backgroundSize: '18px 18px',
              }}
            >
              {loading && !conversationId ? (
                <p className="text-sm text-muted-foreground text-center mt-10">Opening chat…</p>
              ) : error ? (
                <div className="text-center mt-10 space-y-3">
                  <p className="text-sm text-destructive">{error}</p>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                      setError(null)
                      setLoading(true)
                      void ensureThread()
                        .then((data) => applyEnsurePayload(data, myId))
                        .catch((e: any) => setError(e?.message || 'Failed to open job chat'))
                        .finally(() => setLoading(false))
                    }}
                  >
                    Try again
                  </Button>
                </div>
              ) : msgsLoading && messages.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center mt-10">Loading messages…</p>
              ) : messages.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center mt-10">No messages yet. Say hello!</p>
              ) : (
                messages.map((msg, i) => {
                  const prev = i > 0 ? messages[i - 1] : null
                  const showDate =
                    !prev || new Date(msg.createdAt).toDateString() !== new Date(prev.createdAt).toDateString()
                  const next = i < messages.length - 1 ? messages[i + 1] : null
                  const isLastInGroup = !next || next.isMine !== msg.isMine
                  const showName = !msg.isMine && (!prev || prev.isMine !== msg.isMine)

                  return (
                    <div key={msg.id} className={isLastInGroup ? 'mb-2' : 'mb-0.5'}>
                      {showDate && (
                        <div className="flex justify-center my-3">
                          <span className="text-[11px] text-[#54656f] font-medium px-3 py-1 rounded-lg bg-white/90 shadow-sm border border-black/5">
                            {dateSep(msg.createdAt)}
                          </span>
                        </div>
                      )}
                      <MsgBubble
                        msg={msg}
                        showSenderName={showName}
                        showJobLink={false}
                        myId={myId}
                        isHighlighted={highlightedId === msg.id}
                        onReply={handleReply}
                        onToggleReaction={handleToggleReaction}
                        onJumpTo={jumpToMessage}
                        onDelete={handleDelete}
                      />
                    </div>
                  )
                })
              )}
              <div ref={bottomRef} />
            </div>

            <Composer
              isSms={false}
              disabled={!conversationId || selectedRecipientIds.length === 0}
              onSend={handleSend}
              replyPreview={
                replyTarget
                  ? {
                      senderName: replyTarget.isMine ? 'You' : replyTarget.senderName || 'Unknown',
                      textPreview: replyPreviewText(replyTarget),
                    }
                  : null
              }
              onClearReply={() => setReplyTarget(null)}
            />
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
