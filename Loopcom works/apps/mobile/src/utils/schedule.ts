export function combineDateAndTime(dateValue: Date | null, timeValue: Date | null): string | null {
  if (!dateValue || !timeValue) return null
  const combined = new Date(dateValue)
  combined.setHours(timeValue.getHours(), timeValue.getMinutes(), 0, 0)
  return combined.toISOString()
}

export function splitDateAndTime(value: string | null | undefined): {
  date: Date | null
  time: Date | null
} {
  if (!value) return { date: null, time: null }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return { date: null, time: null }
  return {
    date: parsed,
    time: parsed,
  }
}

export function formatScheduledAt(value: string | null | undefined) {
  if (!value) return 'Optional / Unscheduled'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return 'Optional / Unscheduled'
  return `${parsed.toLocaleDateString()} at ${parsed.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  })}`
}
