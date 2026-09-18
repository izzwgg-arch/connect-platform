export const JOB_TYPES = [
  { value: 'CUSTOM', label: 'Custom' },
  { value: 'STANDARD', label: 'Standard' },
  { value: 'RAILING', label: 'Railing' },
  { value: 'CLOSETS', label: 'Closets' },
] as const

export type JobTypeValue = (typeof JOB_TYPES)[number]['value']

export const JOB_TYPE_VALUES = JOB_TYPES.map((t) => t.value) as [
  JobTypeValue,
  ...JobTypeValue[],
]

export const jobTypeColors: Record<string, string> = {
  CUSTOM: 'bg-violet-100 text-violet-800',
  STANDARD: 'bg-slate-100 text-slate-800',
  RAILING: 'bg-sky-100 text-sky-800',
  CLOSETS: 'bg-amber-100 text-amber-900',
}

export function formatJobType(type: string | null | undefined): string {
  if (!type) return ''
  return JOB_TYPES.find((item) => item.value === type)?.label ?? type.replaceAll('_', ' ')
}

export function parseJobType(value: unknown, fallback: JobTypeValue = 'CUSTOM'): JobTypeValue {
  if (typeof value === 'string' && (JOB_TYPE_VALUES as readonly string[]).includes(value)) {
    return value as JobTypeValue
  }
  return fallback
}
