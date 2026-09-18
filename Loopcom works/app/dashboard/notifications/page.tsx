'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Bell } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { refreshAccessToken } from '@/lib/auth/client'

interface Notification {
  id: string
  title: string
  message: string | null
  linkUrl: string | null
  status: string
  createdAt: string
}

export default function NotificationsPage() {
  const router = useRouter()
  const [items, setItems] = useState<Notification[]>([])
  const [loading, setLoading] = useState(true)

  const fetchAll = async () => {
    try {
      let token = localStorage.getItem('accessToken')
      if (!token) {
        const ok = await refreshAccessToken()
        if (!ok) return router.push('/auth/login')
        token = localStorage.getItem('accessToken')
      }

      let res = await fetch('/api/notifications?limit=200', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.status === 401) {
        const ok = await refreshAccessToken()
        if (!ok) return router.push('/auth/login')
        token = localStorage.getItem('accessToken')
        res = await fetch('/api/notifications?limit=200', {
          headers: { Authorization: `Bearer ${token}` },
        })
      }

      if (!res.ok) throw new Error('Failed')
      const data = await res.json()
      setItems(data.notifications || [])
    } finally {
      setLoading(false)
    }
  }

  const markAllRead = async () => {
    let token = localStorage.getItem('accessToken')
    if (!token) return
    await fetch('/api/notifications/read-all', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    })
    await fetchAll()
  }

  useEffect(() => {
    fetchAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Notifications</h1>
          <p className="mt-1 text-gray-600">All recent notifications</p>
        </div>
        <Button variant="outline" onClick={markAllRead}>
          Mark all as read
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bell className="h-4 w-4" />
            Recent
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-gray-500">Loading...</div>
          ) : items.length === 0 ? (
            <div className="text-gray-500">No notifications.</div>
          ) : (
            <div className="space-y-2">
              {items.map((n) => (
                <div
                  key={n.id}
                  className={`rounded border p-3 cursor-pointer hover:bg-gray-50 ${
                    n.status === 'UNREAD' ? 'border-blue-200 bg-blue-50/30' : 'border-gray-200'
                  }`}
                  onClick={() => {
                    if (n.linkUrl) window.location.href = n.linkUrl
                  }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium text-gray-900">{n.title}</div>
                      {n.message && <div className="text-sm text-gray-600 mt-1">{n.message}</div>}
                      <div className="text-xs text-gray-400 mt-1">
                        {formatDistanceToNow(new Date(n.createdAt), { addSuffix: true })}
                      </div>
                    </div>
                    {n.status === 'UNREAD' && (
                      <span className="text-xs rounded-full bg-blue-600 text-white px-2 py-0.5">Unread</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

