'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { JOB_STATUSES, formatJobStatus, jobStatusColors } from '@/lib/jobs/statuses'

type JobStatusSelectProps = {
  jobId: string
  status: string
  disabled?: boolean
  compact?: boolean
  onUpdated?: (status: string) => void
}

export function JobStatusSelect({
  jobId,
  status,
  disabled = false,
  compact = false,
  onUpdated,
}: JobStatusSelectProps) {
  const router = useRouter()
  const [value, setValue] = useState(status)
  const [updating, setUpdating] = useState(false)

  useEffect(() => {
    setValue(status)
  }, [status])

  const handleChange = async (nextStatus: string) => {
    if (nextStatus === value) return

    setUpdating(true)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const response = await fetch(`/api/jobs/${jobId}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: nextStatus }),
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: 'Failed to update job status' }))
        alert(payload.error || 'Failed to update job status')
        return
      }

      const data = await response.json()
      const updatedStatus = data?.job?.status ?? nextStatus
      setValue(updatedStatus)
      onUpdated?.(updatedStatus)
    } catch (error) {
      console.error('Failed to update job status:', error)
      alert('Failed to update job status')
    } finally {
      setUpdating(false)
    }
  }

  return (
    <div onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <Select value={value} onValueChange={handleChange} disabled={disabled || updating}>
        <SelectTrigger
          className={`${compact ? 'h-8 min-w-[150px] max-w-[200px] text-xs' : 'h-9 min-w-[170px] max-w-[220px] text-sm'} border-0 shadow-none focus:ring-0 ${jobStatusColors[value] || 'bg-gray-100 text-gray-800'}`}
          aria-label="Job status"
        >
          <SelectValue>{updating ? 'Saving...' : formatJobStatus(value)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {JOB_STATUSES.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

export function JobStatusBadge({ status }: { status: string }) {
  return (
    <span className={`px-2 py-1 text-xs rounded-full ${jobStatusColors[status] || 'bg-gray-100 text-gray-800'}`}>
      {formatJobStatus(status)}
    </span>
  )
}
