'use client'

import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { JOB_TYPES, formatJobType, jobTypeColors } from '@/lib/jobs/types'

type JobTypeSelectProps = {
  value: string
  onValueChange: (value: string) => void
  id?: string
  label?: string
  disabled?: boolean
  className?: string
  showLabel?: boolean
  options?: readonly { value: string; label: string }[]
}

export function JobTypeSelect({
  value,
  onValueChange,
  id = 'jobType',
  label = 'Job Type',
  disabled = false,
  className,
  showLabel = true,
  options = JOB_TYPES,
}: JobTypeSelectProps) {
  const items = options.length > 0 ? options : JOB_TYPES
  return (
    <div className={className}>
      {showLabel ? <Label htmlFor={id}>{label}</Label> : null}
      <Select value={value || items[0]?.value || 'CUSTOM'} onValueChange={onValueChange} disabled={disabled}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder="Select job type" />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

export function JobTypeBadge({ jobType }: { jobType?: string | null }) {
  if (!jobType) return null
  return (
    <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${jobTypeColors[jobType] || 'bg-gray-100 text-gray-800'}`}>
      {formatJobType(jobType)}
    </span>
  )
}
