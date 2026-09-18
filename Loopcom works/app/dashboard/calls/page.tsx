'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PaginationControls } from '@/components/ui/PaginationControls'
import { formatDate, formatPhoneNumber } from '@/lib/utils'
import { Search, Filter, Phone, PhoneIncoming, PhoneOutgoing, PhoneMissed, Clock } from 'lucide-react'
import Link from 'next/link'
import { VitalPbxSoftphone, type VitalPbxConfig } from '@/components/calls/VitalPbxSoftphone'

interface Call {
  id: string
  direction: string
  status: string
  fromNumber: string
  toNumber: string
  duration: number | null
  startedAt: string
  answeredAt: string | null
  endedAt: string | null
  user: {
    firstName: string
    lastName: string
  } | null
  client: {
    id: string
    name: string
  } | null
  contact: {
    firstName: string
    lastName: string
  } | null
  job: {
    id: string
    jobNumber: string
  } | null
}

const statusIcons: Record<string, typeof Phone> = {
  ANSWERED: Phone,
  MISSED: PhoneMissed,
  VOICEMAIL: PhoneIncoming,
  FAILED: Phone,
  BUSY: Phone,
  CANCELLED: Phone,
}

const statusColors: Record<string, string> = {
  ANSWERED: 'text-green-600',
  MISSED: 'text-red-600',
  VOICEMAIL: 'text-yellow-600',
  FAILED: 'text-red-600',
  BUSY: 'text-orange-600',
  CANCELLED: 'text-gray-600',
}

export default function CallsPage() {
  const router = useRouter()
  const [calls, setCalls] = useState<Call[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [direction, setDirection] = useState('all')
  const [status, setStatus] = useState('all')
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [vitalConfig, setVitalConfig] = useState<VitalPbxConfig | null>(null)
  const [canCall, setCanCall] = useState(true)
  const [sipPassword, setSipPassword] = useState('')

  useEffect(() => {
    setPage(1)
  }, [search, direction, status])

  useEffect(() => {
    fetchCalls()
    fetchVitalConfig()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, direction, status, page])

  const fetchVitalConfig = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      const userRaw = localStorage.getItem('user')
      const user = userRaw ? JSON.parse(userRaw) : null
      // Basic permission hint: if user permissions are stored client-side, use it; backend still enforces.
      if (user?.permissions && Array.isArray(user.permissions)) {
        setCanCall(user.permissions.includes('calls.send') || user.permissions.includes('calls.view'))
      }

      const res = await fetch('/api/integrations/vitalpbx', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return
      const data = await res.json()
      const s = data?.maskedSecrets || {}
      // NOTE: maskedSecrets returns raw for non-password fields; password will remain masked.
      // For softphone we need the real password, so users must enter it once per browser session.
      // MVP: if password is masked, prompt user in UI later (we’ll keep it simple for now).
      if (s?.wssUrl && s?.sipDomain && s?.extension) {
        setVitalConfig({
          wssUrl: s.wssUrl,
          sipDomain: s.sipDomain,
          extension: s.extension,
          password: '', // set via SIP Password field below
          displayName: s.displayName || undefined,
          outboundCallerId: s.outboundCallerId || undefined,
          iceServersJson: s.iceServersJson || undefined,
        })
      }
    } catch {
      // ignore
    }
  }

  const logCall = async (payload: any) => {
    try {
      const token = localStorage.getItem('accessToken')
      await fetch('/api/calls', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      })
    } catch {
      // ignore
    }
  }

  const fetchCalls = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      const params = new URLSearchParams({
        direction,
        status,
        page: String(page),
        limit: '50',
      })

      if (search) {
        // Search by phone number
        params.append('search', search)
      }

      const response = await fetch(`/api/calls?${params}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      const data = await response.json()
      setCalls(data.calls || [])
      setTotalPages(Number(data?.pagination?.totalPages || 1))
      setTotal(Number(data?.pagination?.total || 0))
    } catch (error) {
      console.error('Failed to fetch calls:', error)
    } finally {
      setLoading(false)
    }
  }

  const formatDuration = (seconds: number | null) => {
    if (!seconds) return 'N/A'
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <p className="mt-4 text-gray-600">Loading calls...</p>
        </div>
      </div>
    )
  }

  const missedCalls = calls.filter((c) => c.status === 'MISSED').length
  const totalDuration = calls.reduce((sum, call) => sum + (call.duration || 0), 0)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Calls</h1>
          <p className="mt-2 text-gray-600">View call history and logs</p>
        </div>
        <Button variant="outline" onClick={() => router.push('/dashboard/settings/integrations/vitalpbx')}>
          Configure VitalPBX
        </Button>
      </div>

      {/* Softphone */}
      {vitalConfig ? (
        <div className="space-y-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">SIP Password</CardTitle>
              <CardDescription>
                Stored encrypted, but never returned to the browser. Enter it here to register this browser session.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex gap-2 items-center">
              <Input
                type="password"
                value={sipPassword}
                onChange={(e) => setSipPassword(e.target.value)}
                placeholder="Extension password"
              />
            </CardContent>
          </Card>
          <VitalPbxSoftphone
            config={{ ...vitalConfig, password: sipPassword }}
          canCall={canCall}
          onLogCall={logCall}
          />
        </div>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Softphone</CardTitle>
            <CardDescription>
              Connect Trim Pro to VitalPBX to make/receive calls in the browser (WebRTC).
            </CardDescription>
          </CardHeader>
          <CardContent className="flex items-center justify-between">
            <p className="text-sm text-gray-600">
              Configure the VitalPBX WebRTC integration first.
            </p>
            <Button onClick={() => router.push('/dashboard/settings/integrations/vitalpbx')}>
              Configure
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Calls</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{calls.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Missed Calls</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">{missedCalls}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Duration</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatDuration(totalDuration)}</div>
          </CardContent>
        </Card>
      </div>

      {/* Search and Filters */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center space-x-4">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              <Input
                placeholder="Search by phone, client, contact, or job..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-10"
              />
            </div>
            <div className="flex items-center space-x-2">
              <Filter className="h-4 w-4 text-gray-400" />
              <Select value={direction} onValueChange={setDirection}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue placeholder="All Directions" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Directions</SelectItem>
                  <SelectItem value="INBOUND">Inbound</SelectItem>
                  <SelectItem value="OUTBOUND">Outbound</SelectItem>
                </SelectContent>
              </Select>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="w-[150px]">
                  <SelectValue placeholder="All Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="ANSWERED">Answered</SelectItem>
                  <SelectItem value="MISSED">Missed</SelectItem>
                  <SelectItem value="VOICEMAIL">Voicemail</SelectItem>
                  <SelectItem value="FAILED">Failed</SelectItem>
                  <SelectItem value="BUSY">Busy</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Calls List */}
      <div className="space-y-2">
        {calls.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Phone className="mx-auto h-12 w-12 text-gray-400" />
              <h3 className="mt-2 text-sm font-medium text-gray-900">No calls</h3>
              <p className="mt-1 text-sm text-gray-500">
                Call history will appear here.
              </p>
            </CardContent>
          </Card>
        ) : (
          calls.map((call) => {
            const StatusIcon = statusIcons[call.status] || Phone
            const isInbound = call.direction === 'INBOUND'
            const displayNumber = isInbound ? call.fromNumber : call.toNumber

            return (
              <Card
                key={call.id}
                className="hover:shadow-md transition-shadow cursor-pointer"
                onClick={() => router.push(`/dashboard/calls/${call.id}`)}
              >
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-4 flex-1">
                      <div className={`p-2 rounded-full ${
                        call.status === 'ANSWERED' ? 'bg-green-100' :
                        call.status === 'MISSED' ? 'bg-red-100' :
                        'bg-gray-100'
                      }`}>
                        {isInbound ? (
                          <PhoneIncoming className={`h-5 w-5 ${statusColors[call.status] || 'text-gray-600'}`} />
                        ) : (
                          <PhoneOutgoing className={`h-5 w-5 ${statusColors[call.status] || 'text-gray-600'}`} />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center space-x-2">
                          <p className="font-semibold">{formatPhoneNumber(displayNumber)}</p>
                          <span className={`text-xs px-2 py-1 rounded ${statusColors[call.status] || 'bg-gray-100 text-gray-800'}`}>
                            {call.status}
                          </span>
                        </div>
                        <div className="flex items-center space-x-3 text-sm text-gray-600 mt-1">
                          {call.client && (
                            <Link
                              href={`/dashboard/clients/${call.client.id}`}
                              onClick={(e) => e.stopPropagation()}
                              className="hover:text-primary hover:underline"
                            >
                              {call.client.name}
                            </Link>
                          )}
                          {call.job && (
                            <Link
                              href={`/dashboard/jobs/${call.job.id}`}
                              onClick={(e) => e.stopPropagation()}
                              className="hover:text-primary hover:underline"
                            >
                              Job {call.job.jobNumber}
                            </Link>
                          )}
                        </div>
                        <div className="flex items-center space-x-3 text-xs text-gray-500 mt-1">
                          <span>{formatDate(call.startedAt)}</span>
                          {call.user && (
                            <span>{'\u2022'} {call.user.firstName} {call.user.lastName}</span>
                          )}
                          {call.duration && (
                            <span className="flex items-center">
                              <Clock className="mr-1 h-3 w-3" />
                              {formatDuration(call.duration)}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })
        )}
      </div>

      <PaginationControls
        page={page}
        totalPages={totalPages}
        total={total}
        disabled={loading}
        onPrev={() => setPage((p) => Math.max(1, p - 1))}
        onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
      />
    </div>
  )
}
