'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { DndContext, DragEndEvent, DragStartEvent, PointerSensor, useDraggable, useDroppable, useSensor, useSensors } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatDateTime } from '@/lib/utils'
import { jobStatusColors } from '@/lib/jobs/statuses'
import { Plus, Calendar as CalendarIcon, ChevronLeft, ChevronRight, GripVertical, Search, Users } from 'lucide-react'
import {
  addDays,
  addHours,
  addMinutes,
  addMonths,
  addWeeks,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  isToday,
  parse,
  startOfMonth,
  startOfWeek,
  subDays,
  subMonths,
  subWeeks,
} from 'date-fns'

const DEFAULT_DURATION_MINUTES = 60
const START_HOUR = 6
const END_HOUR = 20

type Notice = { type: 'success' | 'warning' | 'error'; message: string } | null

interface Schedule {
  id: string
  title: string
  description: string | null
  type: string
  startTime: string
  endTime: string
  allDay: boolean
  user: {
    id: string
    firstName: string
    lastName: string
    email: string
  }
  job: {
    id: string
    jobNumber: string
    title: string
    status: string
    client: {
      name: string
    }
  } | null
}

interface TeamMember {
  id: string
  firstName: string
  lastName: string
  email: string
  role: string
  _count: {
    schedules: number
  }
}

interface JobAddress {
  id: string
  street: string
  city: string
  state: string
  zipCode: string
}

interface JobAssignment {
  user: {
    id: string
    firstName: string
    lastName: string
  }
}

interface JobItem {
  id: string
  jobNumber: string
  title: string
  status: string
  priority: number
  scheduledStart: string | null
  scheduledEnd: string | null
  client: {
    id: string
    name: string
    companyName?: string | null
  }
  assignments: JobAssignment[]
  addresses: JobAddress[]
}

interface JobsResponse {
  jobs: JobItem[]
  pagination?: {
    page: number
    hasMore: boolean
    total: number
  }
}

function getJobDurationMinutes(job: JobItem): number {
  if (!job.scheduledStart || !job.scheduledEnd) return DEFAULT_DURATION_MINUTES
  const start = new Date(job.scheduledStart)
  const end = new Date(job.scheduledEnd)
  const diff = Math.round((end.getTime() - start.getTime()) / 60000)
  return diff > 0 ? diff : DEFAULT_DURATION_MINUTES
}

function slotIdForDate(date: Date): string {
  return `slot:${format(date, "yyyy-MM-dd'T'HH:mm")}`
}

function parseSlotId(slotId: string): Date | null {
  if (!slotId.startsWith('slot:')) return null
  const raw = slotId.replace('slot:', '')
  const parsed = parse(raw, "yyyy-MM-dd'T'HH:mm", new Date())
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function parseDayId(dayId: string): Date | null {
  if (!dayId.startsWith('day:')) return null
  const raw = dayId.replace('day:', '')
  const parsed = parse(raw, 'yyyy-MM-dd', new Date())
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export default function SchedulePage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const jobIdFilter = searchParams.get('jobId') || ''

  const [view, setView] = useState<'day' | 'week' | 'month'>('week')
  const [currentDate, setCurrentDate] = useState(new Date())
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([])
  const [selectedUserId, setSelectedUserId] = useState('all')
  const [loading, setLoading] = useState(true)
  const [conflicts, setConflicts] = useState<string[]>([])

  const [scheduledJobs, setScheduledJobs] = useState<JobItem[]>([])
  const [unscheduledJobs, setUnscheduledJobs] = useState<JobItem[]>([])
  const [unscheduledPage, setUnscheduledPage] = useState(1)
  const [unscheduledHasMore, setUnscheduledHasMore] = useState(false)
  const [unscheduledLoading, setUnscheduledLoading] = useState(false)
  const [activeDragJobId, setActiveDragJobId] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [crewFilter, setCrewFilter] = useState('all')
  const [priorityFilter, setPriorityFilter] = useState('all')

  const [permissionChecked, setPermissionChecked] = useState(false)
  const [canScheduleJobs, setCanScheduleJobs] = useState(false)
  const [canMoveCompleted, setCanMoveCompleted] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  const headerRef = useRef<HTMLDivElement>(null)
  const [headerHeight, setHeaderHeight] = useState(80)

  useEffect(() => {
    fetchTeamMembers()
    fetchPermissions()
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [search])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 3000)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    const el = headerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setHeaderHeight(Math.round(entry.contentRect.height))
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    fetchSchedules()
  }, [view, currentDate, selectedUserId, jobIdFilter])

  useEffect(() => {
    fetchScheduledJobs()
  }, [view, currentDate, selectedUserId, statusFilter, crewFilter, priorityFilter, debouncedSearch])

  useEffect(() => {
    setUnscheduledPage(1)
    setUnscheduledJobs([])
  }, [view, selectedUserId, statusFilter, crewFilter, priorityFilter, debouncedSearch])

  useEffect(() => {
    fetchUnscheduledJobs(unscheduledPage)
  }, [view, unscheduledPage, selectedUserId, statusFilter, crewFilter, priorityFilter, debouncedSearch])

  const weekDays = useMemo(() => {
    const weekStart = startOfWeek(currentDate, { weekStartsOn: 1 })
    return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
  }, [currentDate])

  const timeSlots = useMemo(() => {
    return Array.from({ length: END_HOUR - START_HOUR }, (_, i) => START_HOUR + i)
  }, [])

  const fetchPermissions = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) return
      const response = await fetch('/api/auth/permissions', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })
      if (!response.ok) {
        setCanScheduleJobs(false)
        setCanMoveCompleted(false)
        return
      }

      const data = await response.json()
      const permissions: string[] = Array.isArray(data?.permissions) ? data.permissions : []
      const hasSchedulePermission =
        permissions.includes('schedule_jobs') ||
        permissions.includes('schedule.dispatch') ||
        permissions.includes('schedule.reschedule') ||
        permissions.includes('schedule.edit')
      const hasCompletedOverride =
        permissions.includes('schedule.override_completed') ||
        permissions.includes('dispatch.override_lock')

      setCanScheduleJobs(hasSchedulePermission)
      setCanMoveCompleted(hasCompletedOverride)
    } catch (error) {
      console.error('Failed to load schedule permissions:', error)
      setCanScheduleJobs(false)
      setCanMoveCompleted(false)
    } finally {
      setPermissionChecked(true)
    }
  }

  const fetchTeamMembers = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch('/api/schedules/team', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      if (response.ok) {
        const data = await response.json()
        setTeamMembers(data.teamMembers || [])
      }
    } catch (error) {
      console.error('Failed to fetch team members:', error)
    }
  }

  const fetchSchedules = async () => {
    setLoading(true)
    try {
      const token = localStorage.getItem('accessToken')

      let start: Date
      let end: Date

      switch (view) {
        case 'day':
          start = new Date(currentDate)
          start.setHours(0, 0, 0, 0)
          end = new Date(currentDate)
          end.setHours(23, 59, 59, 999)
          break
        case 'week':
          start = startOfWeek(currentDate, { weekStartsOn: 1 })
          end = endOfWeek(currentDate, { weekStartsOn: 1 })
          break
        case 'month':
          start = startOfMonth(currentDate)
          end = endOfMonth(currentDate)
          break
      }

      const params = new URLSearchParams({
        view,
        startDate: start.toISOString(),
        endDate: end.toISOString(),
        userId: selectedUserId,
      })
      if (jobIdFilter) params.set('jobId', jobIdFilter)

      const response = await fetch(`/api/schedules?${params}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      const data = await response.json()
      setSchedules(data.schedules || [])
      setConflicts(data.conflicts || [])
    } catch (error) {
      console.error('Failed to fetch schedules:', error)
    } finally {
      setLoading(false)
    }
  }

  const buildJobsQuery = (base: Record<string, string>) => {
    const query = new URLSearchParams(base)

    if (debouncedSearch) query.set('search', debouncedSearch)
    if (statusFilter !== 'all') query.set('status', statusFilter)

    const effectiveCrew = crewFilter !== 'all' ? crewFilter : selectedUserId !== 'all' ? selectedUserId : ''
    if (effectiveCrew) query.set('crewId', effectiveCrew)

    if (priorityFilter !== 'all') query.set('priority', priorityFilter)

    return query.toString()
  }

  const fetchScheduledJobs = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      let rangeStart: Date
      let rangeEnd: Date
      if (view === 'month') {
        rangeStart = startOfMonth(currentDate)
        rangeEnd = endOfMonth(currentDate)
      } else if (view === 'day') {
        rangeStart = new Date(currentDate)
        rangeEnd = new Date(currentDate)
      } else {
        rangeStart = startOfWeek(currentDate, { weekStartsOn: 1 })
        rangeEnd = endOfWeek(currentDate, { weekStartsOn: 1 })
      }
      rangeStart.setHours(0, 0, 0, 0)
      rangeEnd.setHours(23, 59, 59, 999)

      const query = buildJobsQuery({
        scheduled: 'true',
        startDate: rangeStart.toISOString(),
        endDate: rangeEnd.toISOString(),
        limit: '300',
      })

      const response = await fetch(`/api/jobs?${query}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      if (!response.ok) {
        console.error('Failed to fetch scheduled jobs')
        return
      }

      const data: JobsResponse = await response.json()
      setScheduledJobs(Array.isArray(data.jobs) ? data.jobs : [])
    } catch (error) {
      console.error('Failed to fetch scheduled jobs:', error)
    }
  }

  const fetchUnscheduledJobs = async (page: number) => {
    setUnscheduledLoading(true)
    try {
      const token = localStorage.getItem('accessToken')
      const query = buildJobsQuery({
        scheduled: 'false',
        page: String(page),
        limit: '25',
      })

      const response = await fetch(`/api/jobs?${query}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      if (!response.ok) {
        console.error('Failed to fetch unscheduled jobs')
        return
      }

      const data: JobsResponse = await response.json()
      const jobs = Array.isArray(data.jobs) ? data.jobs : []

      setUnscheduledJobs((prev) => (page === 1 ? jobs : [...prev, ...jobs]))
      setUnscheduledHasMore(Boolean(data.pagination?.hasMore))
    } catch (error) {
      console.error('Failed to fetch unscheduled jobs:', error)
    } finally {
      setUnscheduledLoading(false)
    }
  }

  const navigateDate = (direction: 'prev' | 'next') => {
    switch (view) {
      case 'day':
        setCurrentDate(direction === 'next' ? addDays(currentDate, 1) : subDays(currentDate, 1))
        break
      case 'week':
        setCurrentDate(direction === 'next' ? addWeeks(currentDate, 1) : subWeeks(currentDate, 1))
        break
      case 'month':
        setCurrentDate(direction === 'next' ? addMonths(currentDate, 1) : subMonths(currentDate, 1))
        break
    }
  }

  const goToToday = () => setCurrentDate(new Date())

  const getSchedulesForDate = (date: Date) => {
    return schedules.filter((schedule) => {
      const scheduleDate = new Date(schedule.startTime)
      return isSameDay(scheduleDate, date)
    })
  }

  const generateMonthDays = () => {
    const monthStart = startOfMonth(currentDate)
    const monthEnd = endOfMonth(currentDate)
    const gridStart = startOfWeek(monthStart, { weekStartsOn: 1 })
    const gridEnd = endOfWeek(monthEnd, { weekStartsOn: 1 })
    const days: Date[] = []
    let day = gridStart
    while (day <= gridEnd) {
      days.push(day)
      day = addDays(day, 1)
    }
    return days
  }

  const findJobById = (jobId: string) => {
    return unscheduledJobs.find((job) => job.id === jobId) || scheduledJobs.find((job) => job.id === jobId) || null
  }

  const canDragJob = (job: JobItem) => {
    if (!canScheduleJobs) return false
    if (job.status === 'COMPLETED') return canMoveCompleted
    return true
  }

  const hasLocalConflict = (jobId: string, start: Date, end: Date, assigneeIds: string[]) => {
    if (assigneeIds.length === 0) return false

    return scheduledJobs.some((job) => {
      if (job.id === jobId) return false
      if (!job.scheduledStart || !job.scheduledEnd) return false
      if (job.status === 'CANCELLED') return false

      const otherAssignees = job.assignments.map((assignment) => assignment.user.id)
      const sharedAssignee = otherAssignees.some((id) => assigneeIds.includes(id))
      if (!sharedAssignee) return false

      const otherStart = new Date(job.scheduledStart)
      const otherEnd = new Date(job.scheduledEnd)
      return start < otherEnd && end > otherStart
    })
  }

  const persistSchedule = async (
    jobId: string,
    scheduledStart: string | null,
    scheduledEnd: string | null,
    force: boolean
  ) => {
    const token = localStorage.getItem('accessToken')
    const response = await fetch(`/api/jobs/${jobId}/schedule`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        scheduledStart,
        scheduledEnd,
        force,
      }),
    })

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}))
      const error = new Error(payload?.error || 'Failed to update schedule') as Error & {
        code?: string
        conflicts?: Array<{ id: string; jobNumber: string; title: string }>
        status?: number
      }
      error.code = payload?.code
      error.conflicts = payload?.conflicts
      error.status = response.status
      throw error
    }

    return response.json()
  }

  const moveJobOptimistically = (
    job: JobItem,
    start: Date | null,
    end: Date | null,
    toUnscheduled: boolean
  ) => {
    const updated: JobItem = {
      ...job,
      scheduledStart: start ? start.toISOString() : null,
      scheduledEnd: end ? end.toISOString() : null,
    }

    setUnscheduledJobs((prev) => {
      const without = prev.filter((item) => item.id !== job.id)
      return toUnscheduled ? [updated, ...without] : without
    })

    setScheduledJobs((prev) => {
      const without = prev.filter((item) => item.id !== job.id)
      return toUnscheduled ? without : [...without, updated]
    })
  }

  const handleJobDrop = async (jobId: string, overId: string) => {
    const job = findJobById(jobId)
    if (!job) return
    if (!canDragJob(job)) return

    const prevUnscheduled = unscheduledJobs
    const prevScheduled = scheduledJobs

    const rollback = () => {
      setUnscheduledJobs(prevUnscheduled)
      setScheduledJobs(prevScheduled)
    }

    if (overId === 'unscheduled') {
      moveJobOptimistically(job, null, null, true)
      try {
        await persistSchedule(job.id, null, null, false)
        setNotice({ type: 'success', message: `${job.jobNumber} moved to Unscheduled.` })
      } catch (error: any) {
        rollback()
        setNotice({ type: 'error', message: error?.message || 'Failed to unschedule job.' })
      }
      return
    }

    let targetStart = parseSlotId(overId)
    if (!targetStart) {
      const targetDay = parseDayId(overId)
      if (!targetDay) return
      const sourceTime = job.scheduledStart ? new Date(job.scheduledStart) : null
      targetStart = new Date(targetDay)
      targetStart.setHours(sourceTime ? sourceTime.getHours() : 9, sourceTime ? sourceTime.getMinutes() : 0, 0, 0)
    }

    const durationMinutes = getJobDurationMinutes(job)
    const targetEnd = addMinutes(targetStart, durationMinutes)
    const assigneeIds = job.assignments.map((assignment) => assignment.user.id)

    if (hasLocalConflict(job.id, targetStart, targetEnd, assigneeIds)) {
      const confirmed = window.confirm('This move overlaps with another assigned job. Continue anyway?')
      if (!confirmed) return
    }

    moveJobOptimistically(job, targetStart, targetEnd, false)

    try {
      await persistSchedule(job.id, targetStart.toISOString(), targetEnd.toISOString(), false)
      setNotice({ type: 'success', message: `${job.jobNumber} scheduled for ${format(targetStart, 'EEE h:mm a')}.` })
    } catch (error: any) {
      if (error?.code === 'SCHEDULE_CONFLICT') {
        const confirmed = window.confirm('Server detected a scheduling conflict. Override and schedule anyway?')
        if (!confirmed) {
          rollback()
          setNotice({ type: 'warning', message: 'Scheduling cancelled due to conflict.' })
          return
        }

        try {
          await persistSchedule(job.id, targetStart.toISOString(), targetEnd.toISOString(), true)
          setNotice({ type: 'warning', message: 'Conflict overridden and schedule updated.' })
          return
        } catch (overrideError: any) {
          rollback()
          setNotice({ type: 'error', message: overrideError?.message || 'Failed to override conflict.' })
          return
        }
      }

      rollback()
      setNotice({ type: 'error', message: error?.message || 'Failed to update schedule.' })
    }
  }

  const handleDragStart = (event: DragStartEvent) => {
    const id = String(event.active.id || '')
    if (!id.startsWith('job:')) return
    setActiveDragJobId(id.replace('job:', ''))
  }

  const handleDragEnd = async (event: DragEndEvent) => {
    const activeId = String(event.active.id || '')
    const overId = event.over ? String(event.over.id) : ''
    setActiveDragJobId(null)

    if (!overId || !activeId.startsWith('job:')) return
    const jobId = activeId.replace('job:', '')
    await handleJobDrop(jobId, overId)
  }

  const getScheduledJobsForSlot = (day: Date, hour: number) => {
    return scheduledJobs
      .filter((job) => {
        if (!job.scheduledStart) return false
        const start = new Date(job.scheduledStart)
        return isSameDay(start, day) && start.getHours() === hour
      })
      .sort((a, b) => {
        const aStart = a.scheduledStart ? new Date(a.scheduledStart).getTime() : 0
        const bStart = b.scheduledStart ? new Date(b.scheduledStart).getTime() : 0
        return aStart - bStart
      })
  }

  const getNoticeClasses = () => {
    if (!notice) return ''
    if (notice.type === 'success') return 'border-emerald-300 bg-emerald-50 text-emerald-800'
    if (notice.type === 'warning') return 'border-amber-300 bg-amber-50 text-amber-800'
    return 'border-red-300 bg-red-50 text-red-800'
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <p className="mt-4 text-gray-600">Loading schedule...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col">

      {/* Page title — scrolls away, not sticky */}
      <div className="flex items-center justify-between pb-4">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Schedule</h1>
          <p className="mt-2 text-gray-600">Dispatch and schedule jobs with drag-and-drop.</p>
        </div>
        <Button onClick={() => router.push('/dashboard/schedule/new')}>
          <Plus className="mr-2 h-4 w-4" />
          New Schedule
        </Button>
      </div>

      {jobIdFilter && (
        <div className="mb-3 flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-sm">
          <div className="flex items-center gap-2">
            <span className="font-medium">Filtered:</span>
            <span>Job schedules only</span>
          </div>
          <Button size="sm" variant="outline" onClick={() => router.push('/dashboard/schedule')}>
            Clear
          </Button>
        </div>
      )}

      {notice && (
        <div className={`mb-3 rounded-md border px-3 py-2 text-sm ${getNoticeClasses()}`}>
          {notice.message}
        </div>
      )}

      {conflicts.length > 0 && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-yellow-300 bg-yellow-50 px-3 py-2 text-yellow-800">
          <CalendarIcon className="h-5 w-5 flex-shrink-0" />
          <p className="text-sm font-medium">Schedule conflicts detected! Please review overlapping appointments.</p>
        </div>
      )}

      {/* ── STICKY NAVIGATION HEADER ── */}
      <div
        ref={headerRef}
        className="sticky top-0 z-20 -mx-6 px-6 py-3 bg-gray-100 border-b border-gray-200 shadow-sm"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center space-x-2">
            <Button variant="outline" size="sm" onClick={() => navigateDate('prev')}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" onClick={goToToday}>
              Today
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigateDate('next')}>
              <ChevronRight className="h-4 w-4" />
            </Button>
            <div className="ml-4">
              <h2 className="text-lg font-semibold">
                {view === 'day' && format(currentDate, 'EEEE, MMMM d, yyyy')}
                {view === 'week' && `${format(startOfWeek(currentDate, { weekStartsOn: 1 }), 'MMM d')} – ${format(endOfWeek(currentDate, { weekStartsOn: 1 }), 'MMM d, yyyy')}`}
                {view === 'month' && format(currentDate, 'MMMM yyyy')}
              </h2>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Select value={selectedUserId} onValueChange={setSelectedUserId}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="All Team" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Team</SelectItem>
                {teamMembers.map((member) => (
                  <SelectItem key={member.id} value={member.id}>
                    {member.firstName} {member.lastName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="flex items-center rounded-md border overflow-hidden">
              <button
                onClick={() => setView('day')}
                className={`px-3 py-2 text-sm ${view === 'day' ? 'bg-primary text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
              >
                Day
              </button>
              <button
                onClick={() => setView('week')}
                className={`border-l px-3 py-2 text-sm ${view === 'week' ? 'bg-primary text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
              >
                Week
              </button>
              <button
                onClick={() => setView('month')}
                className={`border-l px-3 py-2 text-sm ${view === 'month' ? 'bg-primary text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
              >
                Month
              </button>
            </div>
          </div>
        </div>

        {permissionChecked && !canScheduleJobs && (
          <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2">
            <p className="text-sm text-amber-800">
              You can view schedule data but cannot drag and drop jobs without schedule permissions.
            </p>
          </div>
        )}
      </div>

      {/* ── MAIN BODY: sticky Unscheduled Panel + scrollable Calendar ── */}
      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div className="flex gap-4 items-start pt-4">

          {/* STICKY UNSCHEDULED PANEL — stays fixed below nav header */}
          <div
            className="sticky flex-none w-[300px] xl:w-[330px]"
            style={{
              top: `${headerHeight}px`,
              height: `calc(100vh - ${headerHeight + 8}px)`,
            }}
          >
            <UnscheduledPanel
              jobs={unscheduledJobs}
              loading={unscheduledLoading}
              hasMore={unscheduledHasMore}
              onLoadMore={() => setUnscheduledPage((prev) => prev + 1)}
              search={search}
              onSearchChange={setSearch}
              statusFilter={statusFilter}
              onStatusFilterChange={setStatusFilter}
              crewFilter={crewFilter}
              onCrewFilterChange={setCrewFilter}
              priorityFilter={priorityFilter}
              onPriorityFilterChange={setPriorityFilter}
              teamMembers={teamMembers}
              activeDragJobId={activeDragJobId}
              canDragJob={canDragJob}
            />
          </div>

          {/* CALENDAR CONTENT — scrolls with the page */}
          <div className="flex-1 min-w-0 pb-10">

            {/* ── DAY VIEW ── */}
            {view === 'day' && (
              <div className="space-y-4">
                <DayCalendar
                  day={currentDate}
                  scheduledJobs={scheduledJobs}
                  timeSlots={timeSlots}
                  activeDragJobId={activeDragJobId}
                  canDragJob={canDragJob}
                  onOpenJob={(jobId) => router.push(`/dashboard/jobs/${jobId}`)}
                />
                {getSchedulesForDate(currentDate).filter((s) => !s.job).length > 0 && (
                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base">Other Schedule Entries</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {getSchedulesForDate(currentDate)
                        .filter((s) => !s.job)
                        .map((schedule) => (
                          <div
                            key={schedule.id}
                            className="cursor-pointer rounded-lg border p-4 transition-shadow hover:shadow-md"
                            onClick={() => router.push(`/dashboard/schedule/${schedule.id}`)}
                          >
                            <div className="flex items-start justify-between">
                              <div className="flex-1">
                                <h3 className="font-semibold">{schedule.title}</h3>
                                <p className="mt-1 text-sm text-gray-600">
                                  {formatDateTime(schedule.startTime)} – {formatDateTime(schedule.endTime)}
                                </p>
                                <p className="mt-1 text-sm text-gray-500">
                                  {schedule.user.firstName} {schedule.user.lastName}
                                </p>
                                {schedule.description && (
                                  <p className="mt-2 text-sm text-gray-600">{schedule.description}</p>
                                )}
                              </div>
                              <span className="rounded bg-blue-100 px-2 py-1 text-xs text-blue-800">{schedule.type}</span>
                            </div>
                          </div>
                        ))}
                    </CardContent>
                  </Card>
                )}
              </div>
            )}

            {/* ── WEEK VIEW ── */}
            {view === 'week' && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Dispatch Calendar</CardTitle>
                  <CardDescription>Drag from Unscheduled to a time slot, drag between slots to reschedule, or back to Unscheduled.</CardDescription>
                </CardHeader>
                <CardContent className="overflow-x-auto p-0">
                  <div className="min-w-[700px]">
                    <div className="grid grid-cols-[80px_repeat(7,minmax(100px,1fr))] border-b bg-gray-50">
                      <div className="p-2 text-xs font-semibold text-gray-500">Time</div>
                      {weekDays.map((day) => (
                        <div key={day.toISOString()} className={`border-l p-2 text-center ${isToday(day) ? 'bg-blue-50' : ''}`}>
                          <p className="text-xs font-medium uppercase text-gray-500">{format(day, 'EEE')}</p>
                          <p className={`text-sm font-semibold ${isToday(day) ? 'text-blue-700' : 'text-gray-900'}`}>{format(day, 'MMM d')}</p>
                        </div>
                      ))}
                    </div>
                    <div>
                      {timeSlots.map((hour) => (
                        <div key={hour} className="grid grid-cols-[80px_repeat(7,minmax(100px,1fr))] border-b last:border-b-0">
                          <div className="border-r p-2 text-xs text-gray-500 flex items-start pt-2">
                            {format(addHours(new Date(new Date().setHours(0, 0, 0, 0)), hour), 'h:mm a')}
                          </div>
                          {weekDays.map((day) => {
                            const slotDate = new Date(day)
                            slotDate.setHours(hour, 0, 0, 0)
                            const jobsInSlot = getScheduledJobsForSlot(day, hour)
                            return (
                              <CalendarSlot
                                key={slotIdForDate(slotDate)}
                                slotId={slotIdForDate(slotDate)}
                                jobs={jobsInSlot}
                                onOpenJob={(jobId) => router.push(`/dashboard/jobs/${jobId}`)}
                                activeDragJobId={activeDragJobId}
                                canDragJob={canDragJob}
                              />
                            )
                          })}
                        </div>
                      ))}
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* ── MONTH VIEW ── */}
            {view === 'month' && (
              <Card>
                <CardContent className="pt-6">
                  <div className="mb-2 grid grid-cols-7 gap-1">
                    {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => (
                      <div key={day} className="py-1 text-center text-sm font-medium text-gray-500">
                        {day}
                      </div>
                    ))}
                  </div>
                  <div className="grid grid-cols-7 gap-1">
                    {generateMonthDays().map((day) => {
                      const inCurrentMonth = isSameMonth(day, currentDate)
                      const isCurrentDay = isToday(day)
                      const dayJobs = scheduledJobs
                        .filter((job) => job.scheduledStart && isSameDay(new Date(job.scheduledStart), day))
                        .sort((a, b) => {
                          const aStart = a.scheduledStart ? new Date(a.scheduledStart).getTime() : 0
                          const bStart = b.scheduledStart ? new Date(b.scheduledStart).getTime() : 0
                          return aStart - bStart
                        })
                      const visibleJobs = dayJobs.slice(0, 3)
                      const remaining = Math.max(0, dayJobs.length - visibleJobs.length)

                      return (
                        <MonthDayCell
                          key={day.toISOString()}
                          day={day}
                          inCurrentMonth={inCurrentMonth}
                          isCurrentDay={isCurrentDay}
                          jobs={visibleJobs}
                          remaining={remaining}
                          onOpenJob={(jobId) => router.push(`/dashboard/jobs/${jobId}`)}
                          onOpenDay={() => {
                            setCurrentDate(day)
                            setView('day')
                          }}
                          activeDragJobId={activeDragJobId}
                          canDragJob={canDragJob}
                        />
                      )
                    })}
                  </div>
                </CardContent>
              </Card>
            )}

          </div>
        </div>
      </DndContext>
    </div>
  )
}

function UnscheduledPanel({
  jobs,
  loading,
  hasMore,
  onLoadMore,
  search,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  crewFilter,
  onCrewFilterChange,
  priorityFilter,
  onPriorityFilterChange,
  teamMembers,
  activeDragJobId,
  canDragJob,
}: {
  jobs: JobItem[]
  loading: boolean
  hasMore: boolean
  onLoadMore: () => void
  search: string
  onSearchChange: (value: string) => void
  statusFilter: string
  onStatusFilterChange: (value: string) => void
  crewFilter: string
  onCrewFilterChange: (value: string) => void
  priorityFilter: string
  onPriorityFilterChange: (value: string) => void
  teamMembers: TeamMember[]
  activeDragJobId: string | null
  canDragJob: (job: JobItem) => boolean
}) {
  const { isOver, setNodeRef } = useDroppable({ id: 'unscheduled' })

  return (
    <Card className={`flex flex-col h-full ${isOver ? 'ring-2 ring-blue-500 ring-offset-2' : ''}`}>
      <CardHeader className="pb-3 flex-none">
        <CardTitle className="text-base">Unscheduled Jobs</CardTitle>
        <CardDescription>Drag into the calendar to schedule.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col flex-1 gap-3 overflow-hidden pb-3" ref={setNodeRef}>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
          <Input value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="Search jobs..." className="pl-9" />
        </div>

        <div className="grid grid-cols-1 gap-2">
          <Select value={statusFilter} onValueChange={onStatusFilterChange}>
            <SelectTrigger>
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="QUOTE">Quote</SelectItem>
              <SelectItem value="SCHEDULED">Scheduled</SelectItem>
              <SelectItem value="IN_PROGRESS">In Progress</SelectItem>
              <SelectItem value="ON_HOLD">On Hold</SelectItem>
              <SelectItem value="COMPLETED">Completed</SelectItem>
            </SelectContent>
          </Select>

          <Select value={crewFilter} onValueChange={onCrewFilterChange}>
            <SelectTrigger>
              <SelectValue placeholder="Crew" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Crew</SelectItem>
              {teamMembers.map((member) => (
                <SelectItem key={member.id} value={member.id}>
                  {member.firstName} {member.lastName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={priorityFilter} onValueChange={onPriorityFilterChange}>
            <SelectTrigger>
              <SelectValue placeholder="Priority" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Priorities</SelectItem>
              <SelectItem value="1">P1</SelectItem>
              <SelectItem value="2">P2</SelectItem>
              <SelectItem value="3">P3</SelectItem>
              <SelectItem value="4">P4</SelectItem>
              <SelectItem value="5">P5</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex-1 min-h-0 space-y-2 overflow-y-auto pr-1">
          {jobs.length === 0 && !loading ? (
            <p className="rounded-md border border-dashed p-4 text-center text-sm text-gray-500">No unscheduled jobs found.</p>
          ) : (
            jobs.map((job) => (
              <UnscheduledJobCard
                key={job.id}
                job={job}
                isDragging={activeDragJobId === job.id}
                isDraggable={canDragJob(job)}
              />
            ))
          )}

          {loading && <p className="text-center text-xs text-gray-500">Loading jobs...</p>}
        </div>

        {hasMore && (
          <Button variant="outline" className="w-full" onClick={onLoadMore} disabled={loading}>
            Load more
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

function UnscheduledJobCard({
  job,
  isDragging,
  isDraggable,
}: {
  job: JobItem
  isDragging: boolean
  isDraggable: boolean
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging: dragging } = useDraggable({
    id: `job:${job.id}`,
    disabled: !isDraggable,
  })

  const style = {
    transform: CSS.Translate.toString(transform),
    opacity: dragging ? 0.45 : isDragging ? 0.7 : 1,
  }

  const address = job.addresses?.[0]
  const disabledByStatus = job.status === 'COMPLETED' && !isDraggable

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`rounded-lg border bg-white p-3 shadow-sm transition ${
        isDraggable ? 'cursor-grab hover:shadow-md' : 'cursor-not-allowed opacity-65'
      }`}
      {...listeners}
      {...attributes}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-gray-900">{job.jobNumber}</p>
          <p className="line-clamp-1 text-sm text-gray-700">{job.title}</p>
          <p className="line-clamp-1 text-xs text-gray-500">{job.client.name}</p>
        </div>
        <span className="rounded border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] text-gray-700">P{job.priority}</span>
      </div>

      <p className="mt-2 line-clamp-1 text-xs text-gray-500">
        {address ? `${address.city || ''}${address.state ? `, ${address.state}` : ''}` : 'No address'}
      </p>

      <div className="mt-2 flex flex-wrap gap-1">
        {job.assignments.length > 0 ? (
          job.assignments.slice(0, 3).map((assignment) => (
            <span key={assignment.user.id} className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-700">
              {assignment.user.firstName}
            </span>
          ))
        ) : (
          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">Unassigned crew</span>
        )}
      </div>

      <div className="mt-2 flex items-center justify-between text-[11px] text-gray-500">
        <span>{job.status.replace('_', ' ')}</span>
        <span className="inline-flex items-center gap-1">
          <GripVertical className="h-3.5 w-3.5" />
          {disabledByStatus ? 'Completed (locked)' : isDraggable ? 'Drag' : 'No permission'}
        </span>
      </div>
    </div>
  )
}

function CalendarSlot({
  slotId,
  jobs,
  onOpenJob,
  activeDragJobId,
  canDragJob,
}: {
  slotId: string
  jobs: JobItem[]
  onOpenJob: (jobId: string) => void
  activeDragJobId: string | null
  canDragJob: (job: JobItem) => boolean
}) {
  const { isOver, setNodeRef } = useDroppable({ id: slotId })

  return (
    <div
      ref={setNodeRef}
      className={`min-h-[72px] border-l p-1.5 transition ${
        isOver ? 'bg-blue-50 ring-1 ring-blue-400' : activeDragJobId ? 'bg-slate-50/40' : 'bg-white'
      }`}
    >
      <div className="space-y-1">
        {jobs.map((job) => (
          <ScheduledJobCard key={job.id} job={job} onOpenJob={onOpenJob} isDraggable={canDragJob(job)} />
        ))}
      </div>
    </div>
  )
}

function ScheduledJobCard({
  job,
  onOpenJob,
  isDraggable,
}: {
  job: JobItem
  onOpenJob: (jobId: string) => void
  isDraggable: boolean
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `job:${job.id}`,
    disabled: !isDraggable,
  })

  const style = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.45 : 1,
  }

  return (
    <button
      type="button"
      ref={setNodeRef}
      style={style}
      className={`w-full rounded border border-transparent px-2 py-1 text-left text-xs transition ${
        isDraggable
          ? `cursor-grab hover:opacity-90 ${jobStatusColors[job.status] || 'bg-blue-100 text-blue-900'}`
          : 'cursor-not-allowed border-gray-200 bg-gray-100 text-gray-700'
      }`}
      onClick={() => onOpenJob(job.id)}
      {...listeners}
      {...attributes}
      title={`${job.jobNumber} \u2022 ${job.client.name}`}
    >
      <p className="truncate font-medium">{job.jobNumber} {job.title}</p>
      <p className="truncate text-[11px] text-gray-600">{job.client.name}</p>
      {job.scheduledStart && <p className="text-[10px] text-gray-500">{format(new Date(job.scheduledStart), 'h:mm a')}</p>}
    </button>
  )
}

function MonthDayCell({
  day,
  inCurrentMonth,
  isCurrentDay,
  jobs,
  remaining,
  onOpenJob,
  onOpenDay,
  activeDragJobId,
  canDragJob,
}: {
  day: Date
  inCurrentMonth: boolean
  isCurrentDay: boolean
  jobs: JobItem[]
  remaining: number
  onOpenJob: (jobId: string) => void
  onOpenDay: () => void
  activeDragJobId: string | null
  canDragJob: (job: JobItem) => boolean
}) {
  const dayId = `day:${format(day, 'yyyy-MM-dd')}`
  const { isOver, setNodeRef } = useDroppable({ id: dayId })

  return (
    <div
      ref={setNodeRef}
      className={`min-h-[120px] rounded-md border p-2 transition-colors ${
        inCurrentMonth ? 'bg-white' : 'bg-gray-50'
      } ${isCurrentDay ? 'border-blue-500' : 'border-gray-200'} ${
        isOver ? 'ring-2 ring-blue-400 ring-offset-1' : activeDragJobId ? 'bg-slate-50/40' : ''
      }`}
    >
      <button
        type="button"
        className={`mb-2 text-sm font-semibold ${inCurrentMonth ? 'text-gray-900' : 'text-gray-400'} ${
          isCurrentDay ? 'text-blue-600' : ''
        }`}
        onClick={onOpenDay}
      >
        {format(day, 'd')}
      </button>

      <div className="space-y-1">
        {jobs.map((job) => (
          <MonthJobChip key={job.id} job={job} onOpenJob={onOpenJob} isDraggable={canDragJob(job)} />
        ))}

        {remaining > 0 && (
          <button type="button" className="text-[11px] text-blue-600 hover:underline" onClick={onOpenDay}>
            +{remaining} more
          </button>
        )}
      </div>
    </div>
  )
}

function MonthJobChip({
  job,
  onOpenJob,
  isDraggable,
}: {
  job: JobItem
  onOpenJob: (jobId: string) => void
  isDraggable: boolean
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `job:${job.id}`,
    disabled: !isDraggable,
  })

  const style = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.45 : 1,
  }

  return (
    <button
      type="button"
      ref={setNodeRef}
      style={style}
      className={`w-full truncate rounded px-1.5 py-1 text-left text-[11px] ${
        isDraggable
          ? `cursor-grab hover:opacity-90 ${jobStatusColors[job.status] || 'bg-blue-100 text-blue-900'}`
          : 'cursor-not-allowed bg-gray-100 text-gray-700'
      }`}
      onClick={() => onOpenJob(job.id)}
      {...listeners}
      {...attributes}
      title={`${job.scheduledStart ? format(new Date(job.scheduledStart), 'h:mm a') : ''} ${job.jobNumber} • ${job.title}`}
    >
      {job.scheduledStart ? format(new Date(job.scheduledStart), 'h:mm a') : '9:00 AM'} {job.jobNumber} {job.title}
    </button>
  )
}

function DayCalendar({
  day,
  scheduledJobs,
  timeSlots,
  activeDragJobId,
  canDragJob,
  onOpenJob,
}: {
  day: Date
  scheduledJobs: JobItem[]
  timeSlots: number[]
  activeDragJobId: string | null
  canDragJob: (job: JobItem) => boolean
  onOpenJob: (jobId: string) => void
}) {
  const getJobsForHour = (hour: number) => {
    return scheduledJobs.filter((job) => {
      if (!job.scheduledStart) return false
      const start = new Date(job.scheduledStart)
      return isSameDay(start, day) && start.getHours() === hour
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{format(day, 'EEEE, MMMM d, yyyy')}</CardTitle>
        <CardDescription>Drag jobs from Unscheduled to assign a time slot.</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <div className="min-w-[400px]">
          {timeSlots.map((hour) => {
            const slotDate = new Date(day)
            slotDate.setHours(hour, 0, 0, 0)
            const jobsInSlot = getJobsForHour(hour)
            return (
              <div key={hour} className="grid grid-cols-[80px_1fr] border-b last:border-b-0">
                <div className="border-r p-2 text-xs text-gray-500 flex items-start pt-2.5">
                  {format(addHours(new Date(new Date().setHours(0, 0, 0, 0)), hour), 'h:mm a')}
                </div>
                <CalendarSlot
                  slotId={slotIdForDate(slotDate)}
                  jobs={jobsInSlot}
                  onOpenJob={onOpenJob}
                  activeDragJobId={activeDragJobId}
                  canDragJob={canDragJob}
                />
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}