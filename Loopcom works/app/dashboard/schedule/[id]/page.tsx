'use client'
import { EntityBackButton } from '@/components/navigation/EntityBackButton'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Calendar, User, Briefcase } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { formatDateTime } from '@/lib/utils'

type ScheduleDetails = {
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
    phone: string | null
  }
  job: {
    id: string
    jobNumber: string
    title: string
    client: {
      id: string
      name: string
      companyName: string | null
    } | null
  } | null
  lead: {
    id: string
    firstName: string
    lastName: string
  } | null
}

export default function ScheduleDetailsPage() {
  const router = useRouter()
  const params = useParams<{ id: string }>()
  const scheduleId = String(params?.id || '')

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [schedule, setSchedule] = useState<ScheduleDetails | null>(null)

  useEffect(() => {
    if (!scheduleId) return
    const run = async () => {
      setLoading(true)
      setError(null)
      try {
        const token = localStorage.getItem('accessToken')
        const res = await fetch(`/api/schedules/${scheduleId}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.status === 401) {
          router.push('/auth/login')
          return
        }
        const data = await res.json()
        if (!res.ok) {
          setError(data.error || 'Failed to load schedule')
          return
        }
        setSchedule(data.schedule || null)
      } catch (err) {
        console.error('Failed to load schedule:', err)
        setError('Failed to load schedule')
      } finally {
        setLoading(false)
      }
    }
    void run()
  }, [router, scheduleId])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-gray-600">Loading schedule...</p>
      </div>
    )
  }

  if (error || !schedule) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Link href="/dashboard/schedule">
            <Button variant="outline" size="sm">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Schedule
            </Button>
          </Link>
          <h1 className="text-2xl font-bold text-gray-900">Schedule Details</h1>
        </div>
        <Card>
          <CardContent className="pt-6">
            <p className="text-red-600">{error || 'Schedule not found'}</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <EntityBackButton fallbackHref="/dashboard/schedule" />
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Schedule Details</h1>
            <p className="text-gray-600 mt-1">{schedule.title}</p>
          </div>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Calendar className="h-5 w-5" />
            Timing
          </CardTitle>
          <CardDescription>Planned schedule window</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p><span className="font-medium">Start:</span> {formatDateTime(schedule.startTime)}</p>
          <p><span className="font-medium">End:</span> {formatDateTime(schedule.endTime)}</p>
          <p><span className="font-medium">All Day:</span> {schedule.allDay ? 'Yes' : 'No'}</p>
          <p><span className="font-medium">Type:</span> {schedule.type}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <User className="h-5 w-5" />
            Assigned Team Member
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>{schedule.user.firstName} {schedule.user.lastName}</p>
          <p className="text-gray-600">{schedule.user.email}</p>
          {schedule.user.phone ? <p className="text-gray-600">{schedule.user.phone}</p> : null}
        </CardContent>
      </Card>

      {schedule.job ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Briefcase className="h-5 w-5" />
              Linked Job
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p><span className="font-medium">Job:</span> {schedule.job.jobNumber} - {schedule.job.title}</p>
            {schedule.job.client ? <p><span className="font-medium">Client:</span> {schedule.job.client.name}</p> : null}
            <Link href={`/dashboard/jobs/${schedule.job.id}`}>
              <Button variant="outline" size="sm">Open Job</Button>
            </Link>
          </CardContent>
        </Card>
      ) : null}

      {schedule.description ? (
        <Card>
          <CardHeader>
            <CardTitle>Notes</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-gray-700 whitespace-pre-wrap">{schedule.description}</p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
