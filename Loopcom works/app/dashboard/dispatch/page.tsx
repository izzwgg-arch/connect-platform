'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import {
  Calendar,
  Camera,
  CheckCircle2,
  Circle,
  Clock3,
  Film,
  LayoutGrid,
  List,
  MapPin,
  MessageSquare,
  Plus,
  Radio,
  Search,
  ShieldAlert,
  User,
  Video,
  X,
} from 'lucide-react'

function VideoThumbnail({ src, className = 'h-full w-full object-cover bg-black/80' }: { src: string; className?: string }) {
  const videoRef = useRef<HTMLVideoElement>(null)

  const handleMouseEnter = () => {
    if (videoRef.current) {
      videoRef.current.play().catch(() => {
        // Ignore autoplay errors
      })
    }
  }

  const handleMouseLeave = () => {
    if (videoRef.current) {
      videoRef.current.pause()
      videoRef.current.currentTime = 0
    }
  }

  return (
    <video
      ref={videoRef}
      src={src}
      className={className}
      muted
      loop
      playsInline
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    />
  )
}

type DispatchView = 'board' | 'calendar' | 'list' | 'live'

type Job = {
  id: string
  jobNumber: string
  title: string
  status: string
  priority: number
  scheduledStart: string | null
  scheduledEnd: string | null
  client: { id: string; name: string }
  jobSite: { street?: string; city?: string; state?: string; zipCode?: string } | null
  assignments: Array<{ id: string; firstName: string; lastName: string; email?: string | null }>
  assignedTo: { id: string; firstName: string; lastName: string } | null
  indicators: {
    newPhoto: boolean
    newVideo: boolean
    newFile: boolean
    newMessage: boolean
    issueReported: boolean
    taskCompleted: boolean
    recentActivityCount: number
  }
}

type Crew = {
  id: string
  firstName: string
  lastName: string
  email: string
  availabilityStatus: 'AVAILABLE' | 'BUSY' | 'OVERBOOKED'
  workload: number
  todaySchedule: Array<{
    id: string
    jobNumber: string
    title: string
    status: string
    scheduledStart: string | null
  }>
}

type LiveItem = {
  id: string
  kind: 'dispatch_event' | 'photo' | 'video' | 'file' | 'message'
  ts: string
  jobId?: string | null
  eventType?: string
  payload?: any
  body?: string | null
  attachment?: any
  media?: any[]
  job?: { id: string; jobNumber: string; title: string; client?: { name: string } }
}

export default function DispatchPage() {
  const router = useRouter()
  const [jobs, setJobs] = useState<Job[]>([])
  const [crews, setCrews] = useState<Crew[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<DispatchView>('board')
  const [statusFilter, setStatusFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [dateFilter, setDateFilter] = useState<'today' | 'tomorrow' | 'custom'>('today')
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0] || '')
  const [showAssignment, setShowAssignment] = useState(false)
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [panel, setPanel] = useState<any>(null)
  const [panelTab, setPanelTab] = useState('overview')
  const [chatText, setChatText] = useState('')
  const [liveFeed, setLiveFeed] = useState<LiveItem[]>([])
  const [soundEnabled, setSoundEnabled] = useState(false)
  const [unreadLiveCount, setUnreadLiveCount] = useState(0)
  const [broadcastText, setBroadcastText] = useState('')
  const [permissionChecked, setPermissionChecked] = useState(false)
  const [hasDispatchPermission, setHasDispatchPermission] = useState(true)

  const [assignForm, setAssignForm] = useState({
    jobId: '',
    userId: '',
    scheduledStart: '',
    scheduledEnd: '',
  })
  const dragJobIdRef = useRef<string | null>(null)
  const lastSseCursorRef = useRef<string>(new Date(Date.now() - 60_000).toISOString())
  const eventSourceRef = useRef<EventSource | null>(null)

  const activeDate = useMemo(() => {
    if (dateFilter === 'today') return new Date().toISOString().split('T')[0] || ''
    if (dateFilter === 'tomorrow') {
      const d = new Date(Date.now() + 86400000)
      return d.toISOString().split('T')[0] || ''
    }
    return selectedDate
  }, [dateFilter, selectedDate])

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search.trim()), 250)
    return () => window.clearTimeout(t)
  }, [search])

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        window.location.href = '/auth/login'
        return
      }
      const qs = new URLSearchParams({
        date: activeDate,
        status: statusFilter,
      })
      if (debouncedSearch) qs.set('search', debouncedSearch)

      const [jobsRes, crewsRes] = await Promise.all([
        fetch(`/api/dispatch/jobs?${qs.toString()}`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch('/api/dispatch/techs', { headers: { Authorization: `Bearer ${token}` } }),
      ])
      if (jobsRes.ok) {
        const j = await jobsRes.json()
        setJobs(Array.isArray(j.jobs) ? j.jobs : [])
      }
      if (crewsRes.ok) {
        const c = await crewsRes.json()
        setCrews(Array.isArray(c.techs) ? c.techs : [])
      }
    } catch (error) {
      console.error('Dispatch fetch failed:', error)
    } finally {
      setLoading(false)
    }
  }, [activeDate, debouncedSearch, statusFilter])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  useEffect(() => {
    const checkPermission = async () => {
      try {
        const token = localStorage.getItem('accessToken')
        if (!token) return
        const res = await fetch('/api/auth/permissions', { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) {
          setHasDispatchPermission(false)
          setPermissionChecked(true)
          return
        }
        const data = await res.json()
        const perms: string[] = Array.isArray(data?.permissions) ? data.permissions : []
        setHasDispatchPermission(perms.includes('dispatch.view'))
      } catch {
        setHasDispatchPermission(false)
      } finally {
        setPermissionChecked(true)
      }
    }
    checkPermission()
  }, [])

  useEffect(() => {
    if (permissionChecked && !hasDispatchPermission) {
      router.replace('/dashboard')
    }
  }, [hasDispatchPermission, permissionChecked, router])

  useEffect(() => {
    if (eventSourceRef.current) eventSourceRef.current.close()
    const sse = new EventSource(`/api/dispatch/stream?since=${encodeURIComponent(lastSseCursorRef.current)}`)
    eventSourceRef.current = sse

    const playSound = () => {
      if (!soundEnabled) return
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'triangle'
      osc.frequency.value = 880
      gain.gain.value = 0.05
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start()
      setTimeout(() => {
        osc.stop()
        ctx.close()
      }, 120)
    }

    sse.addEventListener('feed', (evt: MessageEvent) => {
      try {
        const parsed = JSON.parse(evt.data)
        const items: LiveItem[] = Array.isArray(parsed?.items) ? parsed.items : []
        if (!items.length) return
        lastSseCursorRef.current = parsed?.cursor || new Date().toISOString()
        setLiveFeed((prev) => [...items.reverse(), ...prev].slice(0, 400))
        setUnreadLiveCount((v) => v + items.length)
        if (document.hidden) {
          if ('Notification' in window && Notification.permission === 'granted') {
            const first = items[0]
            new Notification('Dispatch Live Update', {
              body: first?.job ? `${first.job.jobNumber} · ${first.job.title}` : 'New field activity',
            })
          }
        }
        playSound()
        fetchData()
      } catch (error) {
        console.error('Dispatch stream parse error:', error)
      }
    })

    sse.onerror = () => {
      setTimeout(() => {
        if (eventSourceRef.current) eventSourceRef.current.close()
        eventSourceRef.current = null
      }, 1000)
    }

    return () => {
      sse.close()
      eventSourceRef.current = null
    }
  }, [fetchData, soundEnabled])

  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {})
    }
  }, [])

  const openPanel = useCallback(async (jobId: string, tab: string = 'overview') => {
    setPanelOpen(true)
    setSelectedJobId(jobId)
    setPanelTab(tab)
    const token = localStorage.getItem('accessToken')
    const res = await fetch(`/api/dispatch/jobs/${jobId}/detail`, { headers: { Authorization: `Bearer ${token}` } })
    if (res.ok) {
      setPanel(await res.json())
    }
  }, [])

  const upsertAssignment = useCallback(
    async (jobId: string, userId: string | null, scheduledStart?: string, scheduledEnd?: string) => {
      const toApiDateTime = (v?: string) => {
        const raw = String(v || '').trim()
        if (!raw) return null
        const d = new Date(raw)
        if (Number.isNaN(d.getTime())) return null
        return d.toISOString()
      }
      setBusy(true)
      try {
        const token = localStorage.getItem('accessToken')
        const res = await fetch('/api/dispatch/assign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            jobId,
            userId,
            scheduledStart: toApiDateTime(scheduledStart),
            scheduledEnd: toApiDateTime(scheduledEnd),
          }),
        })
        if (!res.ok) {
          const e = await res.json().catch(() => ({}))
          alert(e?.error || 'Failed to assign')
          return
        }
        await fetchData()
      } finally {
        setBusy(false)
      }
    },
    [fetchData]
  )

  const updateStatus = useCallback(
    async (jobId: string, status: string) => {
      const token = localStorage.getItem('accessToken')
      const res = await fetch(`/api/dispatch/jobs/${jobId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status }),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        alert(e?.error || 'Unable to update status')
        return
      }
      await fetchData()
    },
    [fetchData]
  )

  const sendDispatchMessage = useCallback(async () => {
    if (!selectedJobId || !chatText.trim()) return
    const token = localStorage.getItem('accessToken')
    const res = await fetch(`/api/dispatch/jobs/${selectedJobId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ body: chatText.trim() }),
    })
    if (res.ok) {
      setChatText('')
      await openPanel(selectedJobId, 'messages')
    }
  }, [chatText, openPanel, selectedJobId])

  const sendBroadcast = useCallback(async () => {
    const msg = broadcastText.trim()
    if (!msg) return
    const token = localStorage.getItem('accessToken')
    const res = await fetch('/api/dispatch/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message: msg }),
    })
    if (res.ok) {
      setBroadcastText('')
    }
  }, [broadcastText])

  const grouped = useMemo(() => {
    const cols = {
      unassigned: [] as Job[],
      scheduled: [] as Job[],
      inProgress: [] as Job[],
      completed: [] as Job[],
    }
    for (const j of jobs) {
      if (j.status === 'COMPLETED') cols.completed.push(j)
      else if (j.status === 'IN_PROGRESS') cols.inProgress.push(j)
      else if (j.assignments.length === 0) cols.unassigned.push(j)
      else cols.scheduled.push(j)
    }
    return cols
  }, [jobs])

  const openJobs = useMemo(() => jobs.filter((j) => !['COMPLETED', 'CANCELLED'].includes(j.status)), [jobs])

  const onDropStatus = async (statusKey: 'unassigned' | 'scheduled' | 'inProgress' | 'completed') => {
    const jid = dragJobIdRef.current
    if (!jid) return
    dragJobIdRef.current = null
    if (statusKey === 'unassigned') return upsertAssignment(jid, null)
    if (statusKey === 'scheduled') return updateStatus(jid, 'SCHEDULED')
    if (statusKey === 'inProgress') return updateStatus(jid, 'IN_PROGRESS')
    if (statusKey === 'completed') return updateStatus(jid, 'COMPLETED')
  }

  const onDropCrew = async (crewId: string) => {
    const jid = dragJobIdRef.current
    if (!jid) return
    dragJobIdRef.current = null
    const nowIso = new Date().toISOString()
    await upsertAssignment(jid, crewId, nowIso)
  }

  if (loading) {
    return (
      <div className="h-[60vh] grid place-items-center">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700 mx-auto" />
          <p className="text-sm text-slate-500 mt-3">Loading dispatch command center...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4 pb-10">
      <div className="rounded-xl border bg-gradient-to-br from-slate-50 to-slate-100 p-4 shadow-sm">
        <div className="flex flex-wrap gap-3 items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">Dispatch</h1>
            <div className="flex items-center gap-2 text-xs text-emerald-700 mt-1">
              <Circle className="h-2.5 w-2.5 fill-current" />
              <span>Live</span>
              <span className="text-slate-500">· {jobs.length} jobs</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="Filter" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Jobs</SelectItem>
                <SelectItem value="assigned">Assigned</SelectItem>
                <SelectItem value="unassigned">Unassigned</SelectItem>
                <SelectItem value="in_progress">In Progress</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
              </SelectContent>
            </Select>

            <Select value={dateFilter} onValueChange={(v) => setDateFilter(v as any)}>
              <SelectTrigger className="w-[130px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="today">Today</SelectItem>
                <SelectItem value="tomorrow">Tomorrow</SelectItem>
                <SelectItem value="custom">Custom</SelectItem>
              </SelectContent>
            </Select>
            {dateFilter === 'custom' && <Input type="date" className="w-[150px]" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} />}

            <div className="relative">
              <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <Input className="w-[260px] pl-9" placeholder="Search job #, client, address, crew" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>

            <Button variant="outline" onClick={() => setSoundEnabled((v) => !v)}>
              Sound {soundEnabled ? 'On' : 'Off'}
            </Button>
            <Button variant="outline" onClick={() => setShowAssignment(true)}>
              <Plus className="h-4 w-4 mr-1" /> New Assignment
            </Button>
            <Button onClick={() => router.push('/dashboard/jobs/new')}>Quick Create Job</Button>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex border rounded-lg overflow-hidden bg-white shadow-sm">
          <ViewButton icon={<LayoutGrid className="h-4 w-4" />} label="Board" active={view === 'board'} onClick={() => setView('board')} />
          <ViewButton icon={<Calendar className="h-4 w-4" />} label="Calendar" active={view === 'calendar'} onClick={() => setView('calendar')} />
          <ViewButton icon={<List className="h-4 w-4" />} label="List" active={view === 'list'} onClick={() => setView('list')} />
          <ViewButton icon={<Radio className="h-4 w-4" />} label={`Live Feed${unreadLiveCount ? ` (${unreadLiveCount})` : ''}`} active={view === 'live'} onClick={() => { setView('live'); setUnreadLiveCount(0) }} />
        </div>
        <div className="flex items-center gap-2">
          <Input
            className="w-[320px]"
            placeholder="Broadcast message to all active crews..."
            value={broadcastText}
            onChange={(e) => setBroadcastText(e.target.value)}
          />
          <Button variant="outline" onClick={sendBroadcast} disabled={!broadcastText.trim()}>
            Broadcast
          </Button>
        </div>
      </div>

      {view === 'board' && (
        <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
          <BoardColumn title="Unassigned" jobs={grouped.unassigned} onDrop={() => onDropStatus('unassigned')}>
            {grouped.unassigned.slice(0, 80).map((job) => (
              <JobCard key={job.id} job={job} onDragStart={() => (dragJobIdRef.current = job.id)} onOpen={() => openPanel(job.id)} onAssign={() => { setShowAssignment(true); setAssignForm((f) => ({ ...f, jobId: job.id })) }} onMessage={() => openPanel(job.id, 'messages')} onMedia={() => openPanel(job.id, 'media')} />
            ))}
            {grouped.unassigned.length > 80 && <div className="text-xs text-slate-500">Showing first 80 of {grouped.unassigned.length} jobs</div>}
          </BoardColumn>
          <BoardColumn title="Scheduled" jobs={grouped.scheduled} onDrop={() => onDropStatus('scheduled')}>
            {grouped.scheduled.slice(0, 80).map((job) => (
              <JobCard key={job.id} job={job} onDragStart={() => (dragJobIdRef.current = job.id)} onOpen={() => openPanel(job.id)} onAssign={() => { setShowAssignment(true); setAssignForm((f) => ({ ...f, jobId: job.id })) }} onMessage={() => openPanel(job.id, 'messages')} onMedia={() => openPanel(job.id, 'media')} />
            ))}
            {grouped.scheduled.length > 80 && <div className="text-xs text-slate-500">Showing first 80 of {grouped.scheduled.length} jobs</div>}
          </BoardColumn>
          <BoardColumn title="In Progress" jobs={grouped.inProgress} onDrop={() => onDropStatus('inProgress')}>
            {grouped.inProgress.slice(0, 80).map((job) => (
              <JobCard key={job.id} job={job} onDragStart={() => (dragJobIdRef.current = job.id)} onOpen={() => openPanel(job.id)} onAssign={() => { setShowAssignment(true); setAssignForm((f) => ({ ...f, jobId: job.id })) }} onMessage={() => openPanel(job.id, 'messages')} onMedia={() => openPanel(job.id, 'media')} />
            ))}
            {grouped.inProgress.length > 80 && <div className="text-xs text-slate-500">Showing first 80 of {grouped.inProgress.length} jobs</div>}
          </BoardColumn>
          <BoardColumn title="Completed" jobs={grouped.completed} onDrop={() => onDropStatus('completed')}>
            {grouped.completed.slice(0, 80).map((job) => (
              <JobCard key={job.id} job={job} onDragStart={() => (dragJobIdRef.current = job.id)} onOpen={() => openPanel(job.id)} onAssign={() => { setShowAssignment(true); setAssignForm((f) => ({ ...f, jobId: job.id })) }} onMessage={() => openPanel(job.id, 'messages')} onMedia={() => openPanel(job.id, 'media')} />
            ))}
            {grouped.completed.length > 80 && <div className="text-xs text-slate-500">Showing first 80 of {grouped.completed.length} jobs</div>}
          </BoardColumn>

          <Card className="xl:col-span-1 shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Crew Availability</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 max-h-[70vh] overflow-auto">
              {crews.map((crew) => (
                <div key={crew.id} onDragOver={(e) => e.preventDefault()} onDrop={() => onDropCrew(crew.id)} className="rounded-lg border p-3 bg-white hover:shadow-sm transition">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium text-sm">{crew.firstName} {crew.lastName}</div>
                    <StatusPill status={crew.availabilityStatus} />
                  </div>
                  <div className="text-xs text-slate-500 mt-1">{crew.workload} active jobs</div>
                  {crew.todaySchedule.length > 0 && (
                    <div className="mt-2 text-xs text-slate-600 space-y-1">
                      {crew.todaySchedule.slice(0, 3).map((s) => (
                        <div key={s.id}>{s.jobNumber} · {s.title}</div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      )}

      {view === 'calendar' && (
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-base">Calendar Scheduling</CardTitle>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="day">
              <TabsList>
                <TabsTrigger value="day">Day</TabsTrigger>
                <TabsTrigger value="week">Week</TabsTrigger>
                <TabsTrigger value="month">Month</TabsTrigger>
              </TabsList>
              <TabsContent value="day" className="mt-4 grid gap-2">
                {jobs
                  .filter((j) => j.scheduledStart?.startsWith(activeDate))
                  .map((j) => (
                    <div key={j.id} className="rounded-lg border p-3 flex items-center justify-between">
                      <div>
                        <div className="font-medium">{j.jobNumber} · {j.title}</div>
                        <div className="text-xs text-slate-500">{j.client.name}</div>
                      </div>
                      <Button variant="outline" size="sm" onClick={() => openPanel(j.id)}>Open</Button>
                    </div>
                  ))}
              </TabsContent>
              <TabsContent value="week" className="mt-4">
                <WeekGrid jobs={jobs} onDropToDay={async (jobId, dayIso) => upsertAssignment(jobId, jobs.find((j) => j.id === jobId)?.assignments[0]?.id || null, `${dayIso}T09:00`)} />
              </TabsContent>
              <TabsContent value="month" className="mt-4 text-sm text-slate-600">
                Month view uses the same drag target behavior as week, with condensed cards for performance.
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      )}

      {view === 'list' && (
        <Card className="shadow-sm">
          <CardContent className="pt-4">
            <div className="max-h-[70vh] overflow-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-slate-500 border-b">
                    <th className="py-2">Job</th>
                    <th>Client</th>
                    <th>Status</th>
                    <th>Crew</th>
                    <th>Schedule</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.slice(0, 180).map((j) => (
                    <tr key={j.id} className="border-b hover:bg-slate-50">
                      <td className="py-2">{j.jobNumber} · {j.title}</td>
                      <td>{j.client.name}</td>
                      <td>{j.status}</td>
                      <td>{j.assignments.map((a) => `${a.firstName} ${a.lastName}`).join(', ') || '—'}</td>
                      <td>{j.scheduledStart ? new Date(j.scheduledStart).toLocaleString() : 'Unscheduled'}</td>
                      <td className="text-right">
                        <Button size="sm" variant="outline" onClick={() => openPanel(j.id)}>Open</Button>
                      </td>
                    </tr>
                  ))}
                  {jobs.length > 180 && (
                    <tr>
                      <td colSpan={6} className="py-3 text-xs text-slate-500 text-center">
                        Showing first 180 of {jobs.length} jobs
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {view === 'live' && (
        <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
          <Card className="xl:col-span-2 shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Active Jobs</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 max-h-[70vh] overflow-auto">
              {openJobs.map((j) => (
                <button key={j.id} className="w-full text-left border rounded-lg p-3 hover:bg-slate-50" onClick={() => openPanel(j.id)}>
                  <div className="font-medium text-sm">{j.jobNumber} · {j.title}</div>
                  <div className="text-xs text-slate-500 mt-1">{j.client.name}</div>
                  <div className="text-xs mt-2 text-slate-600">{j.indicators.recentActivityCount} recent events</div>
                </button>
              ))}
            </CardContent>
          </Card>
          <Card className="xl:col-span-3 shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Live Activity Feed</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 max-h-[70vh] overflow-auto">
              {liveFeed.length === 0 && <div className="text-sm text-slate-500">No live events yet.</div>}
              {liveFeed.map((item) => (
                <div key={item.id} className="rounded-lg border p-3 bg-white">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-medium">
                      {item.job ? `${item.job.jobNumber} · ${item.job.title}` : 'Dispatch Event'}
                    </div>
                    <div className="text-xs text-slate-500">{new Date(item.ts).toLocaleTimeString()}</div>
                  </div>
                  <div className="mt-2 text-sm text-slate-700">
                    {item.kind === 'photo' && `Photo uploaded: ${item.attachment?.fileName || ''}`}
                    {item.kind === 'video' && `Video uploaded: ${item.attachment?.fileName || ''}`}
                    {item.kind === 'file' && `File uploaded: ${item.attachment?.fileName || ''}`}
                    {item.kind === 'message' && (item.body || 'New dispatch message')}
                    {item.kind === 'dispatch_event' && `${item.eventType || 'Event'} ${item.payload?.notes ? `· ${item.payload.notes}` : ''}`}
                  </div>
                  {item.attachment?.url && (
                    <div className="mt-2 space-y-2">
                      {String(item.attachment?.mimeType || '').startsWith('image/') && (
                        <img src={item.attachment.url} alt={item.attachment.fileName || 'upload'} className="max-h-48 rounded border object-cover" />
                      )}
                      {String(item.attachment?.mimeType || '').startsWith('video/') && (
                        <VideoThumbnail src={item.attachment.url} className="max-h-56 rounded border w-full bg-black/80" />
                      )}
                      <a className="text-xs text-blue-600 underline inline-block" href={item.attachment.url} target="_blank" rel="noreferrer">
                        Open media
                      </a>
                    </div>
                  )}
                  {item.job?.id && (
                    <div className="mt-2">
                      <Button size="sm" variant="outline" onClick={() => openPanel(item.job!.id!, 'messages')}>
                        Quick reply
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      )}

      <Dialog open={showAssignment} onOpenChange={setShowAssignment}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Assignment</DialogTitle>
            <DialogDescription>Assign any open job to crew and schedule it.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Job</Label>
              <select
                className="mt-1 w-full h-10 rounded-md border border-slate-200 bg-white px-3 text-sm"
                value={assignForm.jobId}
                onChange={(e) => setAssignForm((f) => ({ ...f, jobId: e.target.value }))}
              >
                <option value="">Select job</option>
                {openJobs.map((j) => (
                  <option value={j.id} key={j.id}>
                    {j.jobNumber} - {j.title}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>Crew</Label>
              <select
                className="mt-1 w-full h-10 rounded-md border border-slate-200 bg-white px-3 text-sm"
                value={assignForm.userId}
                onChange={(e) => setAssignForm((f) => ({ ...f, userId: e.target.value }))}
              >
                <option value="">Select crew</option>
                {crews.map((c) => (
                  <option value={c.id} key={c.id}>
                    {c.firstName} {c.lastName}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>Start</Label>
                <Input type="datetime-local" value={assignForm.scheduledStart} onChange={(e) => setAssignForm((f) => ({ ...f, scheduledStart: e.target.value }))} />
              </div>
              <div>
                <Label>End</Label>
                <Input type="datetime-local" value={assignForm.scheduledEnd} onChange={(e) => setAssignForm((f) => ({ ...f, scheduledEnd: e.target.value }))} />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setShowAssignment(false)}>Cancel</Button>
              <Button
                disabled={busy || !assignForm.jobId || !assignForm.userId}
                onClick={async () => {
                  await upsertAssignment(assignForm.jobId, assignForm.userId, assignForm.scheduledStart, assignForm.scheduledEnd)
                  setShowAssignment(false)
                }}
              >
                Confirm Assignment
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {panelOpen && (
        <div className="fixed inset-0 z-50 flex">
          <button className="flex-1 bg-black/20" onClick={() => setPanelOpen(false)} />
          <div className="w-full max-w-2xl bg-white shadow-2xl border-l h-full overflow-y-auto">
            <div className="sticky top-0 bg-white border-b p-3 flex items-center justify-between z-10">
              <div>
                <div className="font-semibold">{panel?.job?.jobNumber} · {panel?.job?.title}</div>
                <div className="text-xs text-slate-500">{panel?.job?.client?.name}</div>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setPanelOpen(false)}><X className="h-4 w-4" /></Button>
            </div>
            <div className="p-4">
              <Tabs value={panelTab} onValueChange={setPanelTab}>
                <TabsList className="w-full grid grid-cols-6">
                  <TabsTrigger value="overview">Overview</TabsTrigger>
                  <TabsTrigger value="media">Media</TabsTrigger>
                  <TabsTrigger value="messages">Messages</TabsTrigger>
                  <TabsTrigger value="tasks">Tasks</TabsTrigger>
                  <TabsTrigger value="issues">Issues</TabsTrigger>
                  <TabsTrigger value="activity">Activity</TabsTrigger>
                </TabsList>
                <TabsContent value="overview" className="space-y-2 mt-3 text-sm">
                  <div><strong>Status:</strong> {panel?.job?.status}</div>
                  <div><strong>Schedule:</strong> {panel?.job?.scheduledStart ? new Date(panel.job.scheduledStart).toLocaleString() : 'Unscheduled'}</div>
                  <div><strong>Address:</strong> {panel?.job?.jobSite ? `${panel.job.jobSite.street || ''} ${panel.job.jobSite.city || ''}, ${panel.job.jobSite.state || ''}` : 'N/A'}</div>
                  <div><strong>Crew:</strong> {(panel?.job?.assignments || []).map((a: any) => `${a.firstName} ${a.lastName}`).join(', ') || 'Unassigned'}</div>
                  <div className="flex gap-2 pt-2">
                    <Button size="sm" variant="outline" onClick={() => updateStatus(panel.job.id, 'IN_PROGRESS')}>Mark In Progress</Button>
                    <Button size="sm" variant="outline" onClick={() => updateStatus(panel.job.id, 'COMPLETED')}>Mark Complete</Button>
                    <Button size="sm" variant="outline" onClick={() => updateStatus(panel.job.id, 'CANCELLED')}>Cancel</Button>
                  </div>
                </TabsContent>
                <TabsContent value="media" className="mt-3 grid grid-cols-2 gap-3">
                  {(panel?.media || []).length === 0 && (
                    <div className="col-span-2 text-sm text-slate-500 border rounded-lg p-3">No media uploaded yet.</div>
                  )}
                  {(panel?.media || []).map((m: any) => {
                    const mime = String(m?.mimeType || '')
                    const isImage = mime.startsWith('image/')
                    const isVideo = mime.startsWith('video/')
                    return (
                      <a key={m.id} href={m.url} target="_blank" rel="noreferrer" className="border rounded-lg p-2 block hover:bg-slate-50">
                        <div className="aspect-square w-full overflow-hidden rounded border bg-slate-100">
                          {isImage ? (
                            <img src={m.url} alt={m.fileName || 'media'} className="h-full w-full object-cover" />
                          ) : isVideo ? (
                            <VideoThumbnail src={m.url} />
                          ) : (
                            <div className="h-full w-full grid place-items-center text-slate-500">
                              <Film className="h-6 w-6" />
                            </div>
                          )}
                        </div>
                        <div className="mt-2 text-sm font-medium truncate">{m.fileName}</div>
                        <div className="text-xs text-slate-500">{m.mimeType}</div>
                      </a>
                    )
                  })}
                </TabsContent>
                <TabsContent value="messages" className="mt-3 space-y-3">
                  <div className="max-h-[45vh] overflow-auto space-y-2 border rounded-lg p-2">
                    {(panel?.messages || []).map((m: any) => (
                      <div key={m.id} className="text-sm border-b pb-2">
                        <div>{m.body || 'Attachment'}</div>
                        <div className="text-xs text-slate-500">{new Date(m.createdAt).toLocaleString()}</div>
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <Textarea value={chatText} onChange={(e) => setChatText(e.target.value)} placeholder="Message crew..." />
                    <Button onClick={sendDispatchMessage}>Send</Button>
                  </div>
                </TabsContent>
                <TabsContent value="tasks" className="mt-3 space-y-2">
                  {(panel?.tasks || []).map((t: any) => (
                    <div key={t.id} className="border rounded-lg p-2 text-sm">
                      <div className="font-medium">{t.title}</div>
                      <div className="text-xs text-slate-500">{t.status}</div>
                    </div>
                  ))}
                </TabsContent>
                <TabsContent value="issues" className="mt-3 space-y-2">
                  {(panel?.issues || []).map((i: any) => (
                    <div key={i.id} className="border rounded-lg p-2 text-sm">
                      <div className="font-medium">{i.title}</div>
                      <div className="text-xs text-slate-500">{i.status} · {i.priority}</div>
                    </div>
                  ))}
                </TabsContent>
                <TabsContent value="activity" className="mt-3 space-y-2">
                  {(panel?.activityLog || []).map((ev: any) => (
                    <div key={ev.id} className="border rounded-lg p-2 text-sm">
                      <div className="font-medium">{ev.eventType}</div>
                      <div className="text-xs text-slate-500">{new Date(ev.timestamp).toLocaleString()}</div>
                    </div>
                  ))}
                </TabsContent>
              </Tabs>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ViewButton({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`px-3 py-2 text-sm inline-flex items-center gap-2 border-r last:border-r-0 ${active ? 'bg-slate-900 text-white' : 'bg-white text-slate-700 hover:bg-slate-50'}`}>
      {icon}
      {label}
    </button>
  )
}

function StatusPill({ status }: { status: Crew['availabilityStatus'] }) {
  const cls =
    status === 'AVAILABLE'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : status === 'BUSY'
      ? 'bg-amber-50 text-amber-700 border-amber-200'
      : 'bg-rose-50 text-rose-700 border-rose-200'
  return <span className={`text-[11px] border px-2 py-0.5 rounded ${cls}`}>{status.toLowerCase()}</span>
}

function BoardColumn({
  title,
  jobs,
  onDrop,
  children,
}: {
  title: string
  jobs: Job[]
  onDrop: () => void
  children: React.ReactNode
}) {
  return (
    <Card className="shadow-sm xl:col-span-1">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center justify-between">
          <span>{title}</span>
          <span className="text-xs text-slate-500">{jobs.length}</span>
        </CardTitle>
      </CardHeader>
      <CardContent onDragOver={(e) => e.preventDefault()} onDrop={onDrop} className="space-y-2 max-h-[70vh] overflow-auto">
        {children}
      </CardContent>
    </Card>
  )
}

function JobCard({
  job,
  onDragStart,
  onOpen,
  onAssign,
  onMessage,
  onMedia,
}: {
  job: Job
  onDragStart: () => void
  onOpen: () => void
  onAssign: () => void
  onMessage: () => void
  onMedia: () => void
}) {
  const priorityColor = job.priority >= 5 ? 'text-rose-700 bg-rose-50 border-rose-200' : job.priority >= 4 ? 'text-amber-700 bg-amber-50 border-amber-200' : 'text-slate-700 bg-slate-50 border-slate-200'
  return (
    <div draggable onDragStart={onDragStart} className="rounded-xl border bg-white p-3 shadow-sm hover:shadow-md transition">
      <div className="flex justify-between gap-2">
        <div>
          <div className="font-medium text-sm">{job.jobNumber}</div>
          <div className="text-sm text-slate-700">{job.title}</div>
          <div className="text-xs text-slate-500 mt-1">{job.client.name}</div>
        </div>
        <span className={`h-fit text-[11px] px-2 py-0.5 rounded border ${priorityColor}`}>P{job.priority}</span>
      </div>
      {job.jobSite && (
        <div className="mt-2 text-xs text-slate-500 flex items-center gap-1">
          <MapPin className="h-3 w-3" />
          <span>{job.jobSite.city || ''} {job.jobSite.state || ''}</span>
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1 text-slate-500">
        {job.indicators.newPhoto && <Camera className="h-3.5 w-3.5" />}
        {job.indicators.newVideo && <Video className="h-3.5 w-3.5" />}
        {job.indicators.newFile && <Film className="h-3.5 w-3.5" />}
        {job.indicators.newMessage && <MessageSquare className="h-3.5 w-3.5" />}
        {job.indicators.issueReported && <ShieldAlert className="h-3.5 w-3.5 text-rose-600" />}
        {job.indicators.taskCompleted && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-1.5">
        <Button 
          variant="outline" 
          size="sm" 
          onClick={onOpen}
          className="text-xs px-2 py-1.5 h-auto flex items-center justify-center gap-1"
        >
          <User className="h-3 w-3 flex-shrink-0" />
          <span className="truncate">Open Job</span>
        </Button>
        <Button 
          variant="outline" 
          size="sm" 
          onClick={onAssign}
          className="text-xs px-2 py-1.5 h-auto flex items-center justify-center gap-1"
        >
          <Plus className="h-3 w-3 flex-shrink-0" />
          <span className="truncate">Assign</span>
        </Button>
        <Button 
          variant="outline" 
          size="sm" 
          onClick={onMessage}
          className="text-xs px-2 py-1.5 h-auto flex items-center justify-center gap-1"
        >
          <MessageSquare className="h-3 w-3 flex-shrink-0" />
          <span className="truncate">Message</span>
        </Button>
        <Button 
          variant="outline" 
          size="sm" 
          onClick={onMedia}
          className="text-xs px-2 py-1.5 h-auto flex items-center justify-center gap-1"
        >
          <Camera className="h-3 w-3 flex-shrink-0" />
          <span className="truncate">Media</span>
        </Button>
      </div>
    </div>
  )
}

function WeekGrid({ jobs, onDropToDay }: { jobs: Job[]; onDropToDay: (jobId: string, dayIso: string) => Promise<void> }) {
  const [dragJobId, setDragJobId] = useState<string | null>(null)
  const days = Array.from({ length: 7 }).map((_, i) => {
    const d = new Date()
    d.setDate(d.getDate() - d.getDay() + i)
    return d
  })
  return (
    <div className="grid grid-cols-1 md:grid-cols-7 gap-2">
      {days.map((d) => {
        const iso = d.toISOString().split('T')[0] || ''
        const dayJobs = jobs.filter((j) => j.scheduledStart?.startsWith(iso))
        return (
          <div key={iso} className="border rounded-lg min-h-[160px] p-2" onDragOver={(e) => e.preventDefault()} onDrop={async () => dragJobId && onDropToDay(dragJobId, iso)}>
            <div className="text-xs font-medium text-slate-600 mb-2">{d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</div>
            <div className="space-y-1">
              {dayJobs.map((j) => (
                <div key={j.id} draggable onDragStart={() => setDragJobId(j.id)} className="text-xs border rounded p-1 bg-slate-50">
                  {j.jobNumber}
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
