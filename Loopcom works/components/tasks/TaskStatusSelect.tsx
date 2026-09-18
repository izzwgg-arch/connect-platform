'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { TASK_STATUSES, formatTaskStatus, taskStatusColors } from '@/lib/tasks/statuses'

type TaskStatusSelectProps = {
  taskId: string
  status: string
  disabled?: boolean
  compact?: boolean
  onUpdated?: (status: string) => void
}

export function TaskStatusSelect({
  taskId,
  status,
  disabled = false,
  compact = false,
  onUpdated,
}: TaskStatusSelectProps) {
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

      const response = await fetch(`/api/tasks/${taskId}`, {
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
        const payload = await response.json().catch(() => ({ error: 'Failed to update task status' }))
        alert(payload.error || 'Failed to update task status')
        return
      }

      const data = await response.json()
      const updatedStatus = data?.task?.status ?? nextStatus
      setValue(updatedStatus)
      onUpdated?.(updatedStatus)
    } catch (error) {
      console.error('Failed to update task status:', error)
      alert('Failed to update task status')
    } finally {
      setUpdating(false)
    }
  }

  return (
    <div onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <Select value={value} onValueChange={handleChange} disabled={disabled || updating}>
        <SelectTrigger
          className={`${compact ? 'h-8 w-[140px] text-xs' : 'h-9 w-[160px] text-sm'} border-0 shadow-none focus:ring-0 ${taskStatusColors[value] || 'bg-gray-100 text-gray-800'}`}
          aria-label="Task status"
        >
          <SelectValue>{updating ? 'Saving...' : formatTaskStatus(value)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {TASK_STATUSES.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

export function TaskStatusBadge({ status }: { status: string }) {
  return (
    <span className={`px-2 py-1 text-xs rounded-full ${taskStatusColors[status] || 'bg-gray-100 text-gray-800'}`}>
      {formatTaskStatus(status)}
    </span>
  )
}
