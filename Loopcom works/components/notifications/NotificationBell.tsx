'use client'

import { useState, useEffect, useRef } from 'react'
import { Bell } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatDistanceToNow } from 'date-fns'
import { cn } from '@/lib/utils'
import { refreshAccessToken } from '@/lib/auth/client'

interface Notification {
  id: string
  type: string
  title: string
  message: string | null
  linkUrl: string | null
  linkType: string | null
  linkId: string | null
  status: string
  createdAt: string
  readAt: string | null
  requiresAck?: boolean
}

export function NotificationBell() {
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [isOpen, setIsOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [toastNotification, setToastNotification] = useState<Notification | null>(null)
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, right: 0 })
  const buttonRef = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const streamAbortRef = useRef<AbortController | null>(null)
  const toastTimerRef = useRef<number | null>(null)
  const shownToastIdsRef = useRef<Set<string>>(new Set())
  const seenNotificationIdsRef = useRef<Set<string>>(new Set())
  const initializedSeenIdsRef = useRef(false)

  const showTransientToast = (notification: Notification) => {
    if (shownToastIdsRef.current.has(notification.id)) return
    shownToastIdsRef.current.add(notification.id)
    setToastNotification(notification)
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current)
      toastTimerRef.current = null
    }
    const isPersistent =
      notification.requiresAck === true ||
      notification.type === 'PAYMENT_RECEIVED' ||
      notification.linkType === 'job' ||
      /payment received|invoice paid|job created/i.test(`${notification.title} ${notification.message || ''}`)
    // Keep payment and job-created toasts visible until the user explicitly closes them.
    if (!isPersistent) {
      toastTimerRef.current = window.setTimeout(() => {
        setToastNotification(null)
      }, 5000)
    }
  }

  useEffect(() => {
    fetchNotifications()
    // Refresh every 30 seconds
    const interval = setInterval(fetchNotifications, 30000)
    return () => {
      clearInterval(interval)
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current)
      }
    }
  }, [])

  const refreshToken = refreshAccessToken

  useEffect(() => {
    const updatePosition = () => {
      if (buttonRef.current && isOpen) {
        const rect = buttonRef.current.getBoundingClientRect()
        const dropdownWidth = 320 // w-80 = 320px
        const dropdownHeight = 384 // max-h-96 = 384px
        const margin = 8
        
        let top = rect.bottom + margin
        let right = window.innerWidth - rect.right
        
        // Ensure dropdown doesn't go off bottom of screen
        if (top + dropdownHeight > window.innerHeight) {
          top = Math.max(margin, window.innerHeight - dropdownHeight - margin)
        }
        
        // Ensure dropdown doesn't go off right side of screen
        if (right + dropdownWidth > window.innerWidth) {
          right = Math.max(margin, window.innerWidth - dropdownWidth - margin)
        }
        
        setDropdownPosition({ top, right })
      }
    }

    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false)
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      updatePosition()
      
      // Update position on scroll and resize
      window.addEventListener('scroll', updatePosition, true)
      window.addEventListener('resize', updatePosition)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      window.removeEventListener('scroll', updatePosition, true)
      window.removeEventListener('resize', updatePosition)
    }
  }, [isOpen])

  useEffect(() => {
    // Real-time stream: start once, keep pushing updates into state.
    // Uses fetch streaming so we can include Authorization header (EventSource can't).
    const startStream = async () => {
      const token = localStorage.getItem('accessToken')
      if (!token) return

      // Avoid duplicate streams
      if (streamAbortRef.current) return

      const abort = new AbortController()
      streamAbortRef.current = abort

      const since = notifications.length > 0 ? notifications[0]?.createdAt : null
      const url = since ? `/api/notifications/stream?since=${encodeURIComponent(since)}` : '/api/notifications/stream'

      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          signal: abort.signal,
        })

        if (res.status === 401) {
          const refreshed = await refreshToken()
          if (!refreshed) throw new Error('unauthorized')
          streamAbortRef.current = null
          return startStream()
        }

        if (!res.ok || !res.body) {
          throw new Error(`stream_failed_${res.status}`)
        }

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          // Parse SSE frames separated by blank lines
          const parts = buffer.split('\n\n')
          buffer = parts.pop() || ''

          for (const part of parts) {
            const lines = part.split('\n')
            const dataLine = lines.find((l) => l.startsWith('data: '))
            const eventLine = lines.find((l) => l.startsWith('event: '))
            const evt = eventLine ? eventLine.replace('event: ', '').trim() : ''
            if (!dataLine) continue
            const payloadStr = dataLine.replace('data: ', '')
            let payload: any = null
            try {
              payload = JSON.parse(payloadStr)
            } catch {
              continue
            }

            if (evt === 'notifications' && payload?.notifications) {
              const incoming: Notification[] = payload.notifications
              incoming
                .filter((n) => n.status === 'UNREAD')
                .forEach((n) => showTransientToast(n))
              setNotifications((prev) => {
                // merge unique by id, newest first
                const map = new Map<string, Notification>()
                ;[...incoming, ...prev].forEach((n) => map.set(n.id, n))
                const merged = Array.from(map.values()).sort(
                  (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
                )
                setUnreadCount(merged.filter((n) => n.status === 'UNREAD').length)
                return merged
              })
            }
          }
        }
      } catch {
        // Stream failure: fallback to polling; try again later.
        streamAbortRef.current = null
      }
    }

    startStream()

    return () => {
      streamAbortRef.current?.abort()
      streamAbortRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fetchNotifications = async () => {
    try {
      let token = localStorage.getItem('accessToken')
      if (!token) {
        const refreshed = await refreshToken()
        if (!refreshed) return
        token = localStorage.getItem('accessToken')
      }

      let response = await fetch('/api/notifications?limit=50', {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (response.status === 401) {
        const refreshed = await refreshToken()
        if (!refreshed) return
        token = localStorage.getItem('accessToken')
        response = await fetch('/api/notifications?limit=50', {
          headers: { Authorization: `Bearer ${token}` },
        })
      }

      if (response.ok) {
        const data = await response.json()
        const notifs = data.notifications || []

        // Polling fallback for popups: if SSE stream drops, still show toasts for newly
        // arrived unread notifications.
        const newlySeen = notifs.filter((n: Notification) => !seenNotificationIdsRef.current.has(n.id))
        if (!initializedSeenIdsRef.current) {
          // First load seeds the set; don't toast old historical notifications.
          initializedSeenIdsRef.current = true
        } else {
          newlySeen
            .filter((n: Notification) => n.status === 'UNREAD')
            .forEach((n: Notification) => showTransientToast(n))
        }

        for (const n of notifs) {
          seenNotificationIdsRef.current.add(n.id)
        }

        setNotifications(notifs)
        setUnreadCount(notifs.filter((n: Notification) => n.status === 'UNREAD').length)
      }
    } catch (error) {
      console.error('Failed to fetch notifications:', error)
    } finally {
      setLoading(false)
    }
  }

  const markAsRead = async (notificationId: string) => {
    try {
      let token = localStorage.getItem('accessToken')
      if (!token) {
        const refreshed = await refreshToken()
        if (!refreshed) return
        token = localStorage.getItem('accessToken')
      }

      let response = await fetch(`/api/notifications/${notificationId}/read`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      })

      if (response.status === 401) {
        const refreshed = await refreshToken()
        if (!refreshed) return
        token = localStorage.getItem('accessToken')
        response = await fetch(`/api/notifications/${notificationId}/read`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        })
      }

      if (response.ok) {
        setNotifications((prev) =>
          prev.map((n) => (n.id === notificationId ? { ...n, status: 'READ', readAt: new Date().toISOString() } : n))
        )
        setUnreadCount((prev) => Math.max(0, prev - 1))
      }
    } catch (error) {
      console.error('Failed to mark notification as read:', error)
    }
  }

  const markAllAsRead = async () => {
    try {
      let token = localStorage.getItem('accessToken')
      if (!token) {
        const refreshed = await refreshToken()
        if (!refreshed) return
        token = localStorage.getItem('accessToken')
      }

      let response = await fetch('/api/notifications/read-all', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      })

      if (response.status === 401) {
        const refreshed = await refreshToken()
        if (!refreshed) return
        token = localStorage.getItem('accessToken')
        response = await fetch('/api/notifications/read-all', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        })
      }

      if (response.ok) {
        setNotifications((prev) =>
          prev.map((n) => ({ ...n, status: 'READ', readAt: n.readAt || new Date().toISOString() }))
        )
        setUnreadCount(0)
      }
    } catch (error) {
      console.error('Failed to mark all as read:', error)
    }
  }

  const handleNotificationClick = (notification: Notification) => {
    markAsRead(notification.id)
    if (notification.linkUrl) {
      window.location.href = notification.linkUrl
    }
    setIsOpen(false)
  }

  const unreadNotifications = notifications.filter((n) => n.status === 'UNREAD')
  const readNotifications = notifications.filter((n) => n.status === 'READ')

  return (
    <>
      {toastNotification && (
        <div className="fixed right-4 top-4 z-[120] w-96 rounded-md border border-green-200 bg-green-50 p-4 shadow-xl">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1">
              <p className="text-sm font-semibold text-green-900">{toastNotification.title}</p>
              {toastNotification.message && (
                <p className="mt-1 text-xs text-green-800 leading-relaxed">{toastNotification.message}</p>
              )}
              {(toastNotification.linkUrl && toastNotification.linkType === 'job') && (
                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    className="rounded bg-green-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-800"
                    onClick={() => {
                      markAsRead(toastNotification.id)
                      window.location.href = toastNotification.linkUrl!
                      setToastNotification(null)
                    }}
                  >
                    View Job
                  </button>
                  <button
                    type="button"
                    className="rounded border border-green-600 px-3 py-1.5 text-xs font-semibold text-green-800 hover:bg-green-100"
                    onClick={() => {
                      markAsRead(toastNotification.id)
                      setToastNotification(null)
                    }}
                  >
                    Dismiss
                  </button>
                </div>
              )}
            </div>
            {!(toastNotification.linkType === 'job') && (
              <button
                type="button"
                className="shrink-0 text-green-800 hover:text-green-900 text-xs"
                onClick={() => setToastNotification(null)}
              >
                Close
              </button>
            )}
          </div>
        </div>
      )}
      <div className="relative">
        <Button
          ref={buttonRef}
          variant="ghost"
          size="sm"
          className="group relative !bg-transparent hover:!bg-transparent active:!bg-transparent focus:!bg-transparent focus-visible:!bg-transparent focus-visible:!ring-0 focus-visible:!ring-offset-0"
          onClick={() => setIsOpen(!isOpen)}
        >
          <Bell
            className={cn(
              'h-5 w-5 transition-colors duration-200 ease-in-out',
              isOpen ? 'text-[#E6C98B]' : 'text-[#FFFFFF] group-hover:text-[#E6C98B]'
            )}
          />
          {unreadCount > 0 && (
            <span className="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-xs font-bold text-white">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </Button>
      </div>

      {isOpen && (
        <div
          ref={dropdownRef}
          className="fixed w-80 rounded-md border border-gray-200 bg-white shadow-lg z-[100]"
          style={{
            top: `${dropdownPosition.top}px`,
            right: `${dropdownPosition.right}px`,
          }}
        >
          <div className="p-4 border-b border-gray-200">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900">Notifications</h3>
              {unreadCount > 0 && (
                <button
                  onClick={markAllAsRead}
                  className="text-sm text-blue-600 hover:text-blue-800"
                >
                  Mark all as read
                </button>
              )}
            </div>
          </div>

          <div className="max-h-96 overflow-y-auto">
            {loading ? (
              <div className="p-4 text-center text-gray-500">Loading...</div>
            ) : notifications.length === 0 ? (
              <div className="p-8 text-center text-gray-500">
                <Bell className="h-12 w-12 mx-auto mb-2 text-gray-400" />
                <p>No notifications</p>
              </div>
            ) : (
              <>
                {unreadNotifications.length > 0 && (
                  <div className="p-2">
                    <div className="text-xs font-semibold text-gray-500 uppercase px-2 py-1">Unread</div>
                    {unreadNotifications.map((notification) => (
                      <div
                        key={notification.id}
                        className="p-3 hover:bg-gray-50 cursor-pointer border-l-2 border-blue-500"
                        onClick={() => handleNotificationClick(notification)}
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <p className="text-sm font-medium text-gray-900">{notification.title}</p>
                            {notification.message && (
                              <p className="text-xs text-gray-600 mt-1 line-clamp-2">{notification.message}</p>
                            )}
                            <p className="text-xs text-gray-400 mt-1">
                              {formatDistanceToNow(new Date(notification.createdAt), { addSuffix: true })}
                            </p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {readNotifications.length > 0 && (
                  <div className="p-2 border-t border-gray-200">
                    <div className="text-xs font-semibold text-gray-500 uppercase px-2 py-1">Read</div>
                    {readNotifications.slice(0, 10).map((notification) => (
                      <div
                        key={notification.id}
                        className="p-3 hover:bg-gray-50 cursor-pointer opacity-75"
                        onClick={() => handleNotificationClick(notification)}
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <p className="text-sm font-medium text-gray-700">{notification.title}</p>
                            {notification.message && (
                              <p className="text-xs text-gray-500 mt-1 line-clamp-2">{notification.message}</p>
                            )}
                            <p className="text-xs text-gray-400 mt-1">
                              {formatDistanceToNow(new Date(notification.createdAt), { addSuffix: true })}
                            </p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {notifications.length > 0 && (
            <div className="p-2 border-t border-gray-200 text-center">
              <a
                href="/dashboard/notifications"
                className="text-sm text-blue-600 hover:text-blue-800"
                onClick={() => setIsOpen(false)}
              >
                View all notifications
              </a>
            </div>
          )}
        </div>
      )}
    </>
  )
}
