export const JOB_STATUSES = [
  { value: 'QUOTE', label: 'Quote' },
  { value: 'SCHEDULED', label: 'Scheduled' },
  { value: 'IN_PROGRESS', label: 'In Progress' },
  { value: 'MEASURED', label: 'Measured' },
  { value: 'NEED_TO_ORDER', label: 'Need to order' },
  { value: 'ORDERED', label: 'Ordered' },
  { value: 'INSTALLATION_COMPLETE', label: 'Installation complete' },
  { value: 'NEED_TOUCH_UPS', label: 'Need touch ups' },
  { value: 'FINISHING_COMPLETE', label: 'Finishing complete' },
  { value: 'ON_HOLD', label: 'On Hold' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'CANCELLED', label: 'Cancelled' },
  { value: 'INVOICED', label: 'Invoiced' },
] as const

export type JobStatusValue = (typeof JOB_STATUSES)[number]['value']

export const JOB_STATUS_VALUES = JOB_STATUSES.map((s) => s.value) as [
  JobStatusValue,
  ...JobStatusValue[],
]

/** Statuses treated as "Active" in list filters. */
export const ACTIVE_JOB_STATUSES: JobStatusValue[] = [
  'SCHEDULED',
  'IN_PROGRESS',
  'MEASURED',
  'NEED_TO_ORDER',
  'ORDERED',
  'INSTALLATION_COMPLETE',
  'NEED_TOUCH_UPS',
  'FINISHING_COMPLETE',
  'ON_HOLD',
]

export const jobStatusColors: Record<string, string> = {
  QUOTE: 'bg-gray-100 text-gray-800',
  SCHEDULED: 'bg-blue-100 text-blue-800',
  IN_PROGRESS: 'bg-yellow-100 text-yellow-800',
  MEASURED: 'bg-indigo-100 text-indigo-800',
  NEED_TO_ORDER: 'bg-amber-100 text-amber-900',
  ORDERED: 'bg-sky-100 text-sky-800',
  INSTALLATION_COMPLETE: 'bg-cyan-100 text-cyan-800',
  NEED_TOUCH_UPS: 'bg-fuchsia-100 text-fuchsia-800',
  FINISHING_COMPLETE: 'bg-teal-100 text-teal-800',
  ON_HOLD: 'bg-orange-100 text-orange-800',
  COMPLETED: 'bg-green-100 text-green-800',
  CANCELLED: 'bg-red-100 text-red-800',
  INVOICED: 'bg-purple-100 text-purple-800',
}

/** Map pin / chart colors (hex). */
export const jobStatusHexColors: Record<string, string> = {
  QUOTE: '#94a3b8',
  SCHEDULED: '#3b82f6',
  IN_PROGRESS: '#eab308',
  MEASURED: '#6366f1',
  NEED_TO_ORDER: '#d97706',
  ORDERED: '#0ea5e9',
  INSTALLATION_COMPLETE: '#06b6d4',
  NEED_TOUCH_UPS: '#d946ef',
  FINISHING_COMPLETE: '#14b8a6',
  ON_HOLD: '#f97316',
  COMPLETED: '#22c55e',
  CANCELLED: '#ef4444',
  INVOICED: '#a855f7',
}

export function formatJobStatus(status: string): string {
  return JOB_STATUSES.find((item) => item.value === status)?.label ?? status.replaceAll('_', ' ')
}
