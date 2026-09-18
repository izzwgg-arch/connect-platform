import { Job } from '../types/models'
import { colors } from '../theme/tokens'

export type ProductionStageId =
  | 'ready'
  | 'scheduled'
  | 'on_site'
  | 'ordering'
  | 'install'
  | 'finish'
  | 'blocked'
  | 'done'

export type WorkQueueId = 'all' | 'do_now' | 'today' | 'waiting' | 'done'

export const PRODUCTION_STAGES: Array<{
  id: ProductionStageId
  label: string
  statuses: string[]
}> = [
  { id: 'ready', label: 'Ready', statuses: ['QUOTE'] },
  { id: 'scheduled', label: 'Scheduled', statuses: ['SCHEDULED'] },
  { id: 'on_site', label: 'On site', statuses: ['IN_PROGRESS', 'MEASURED'] },
  { id: 'ordering', label: 'Ordering', statuses: ['NEED_TO_ORDER', 'ORDERED'] },
  { id: 'install', label: 'Install', statuses: ['INSTALLATION_COMPLETE', 'NEED_TOUCH_UPS'] },
  { id: 'finish', label: 'Finish', statuses: ['FINISHING_COMPLETE'] },
  { id: 'blocked', label: 'Blocked', statuses: ['ON_HOLD'] },
  { id: 'done', label: 'Done', statuses: ['COMPLETED', 'CANCELLED', 'INVOICED'] },
]

export const WORK_QUEUES: Array<{ id: WorkQueueId; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'do_now', label: 'Do now' },
  { id: 'today', label: 'Today' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'done', label: 'Done' },
]

const STATUS_LABELS: Record<string, string> = {
  QUOTE: 'Quote',
  SCHEDULED: 'Scheduled',
  IN_PROGRESS: 'In Progress',
  MEASURED: 'Measured',
  NEED_TO_ORDER: 'Need to order',
  ORDERED: 'Ordered',
  INSTALLATION_COMPLETE: 'Installation complete',
  NEED_TOUCH_UPS: 'Need touch ups',
  FINISHING_COMPLETE: 'Finishing complete',
  ON_HOLD: 'On Hold',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  INVOICED: 'Invoiced',
}

/** Mobile badge colors for the full production pipeline. */
export const JOB_STATUS_BADGE: Record<string, { bg: string; fg: string }> = {
  QUOTE: { bg: 'rgba(148,163,184,0.18)', fg: '#475569' },
  SCHEDULED: { bg: 'rgba(37,99,235,0.12)', fg: colors.info },
  IN_PROGRESS: { bg: 'rgba(234,179,8,0.18)', fg: '#A16207' },
  MEASURED: { bg: 'rgba(99,102,241,0.14)', fg: '#4338CA' },
  NEED_TO_ORDER: { bg: 'rgba(217,119,6,0.16)', fg: '#B45309' },
  ORDERED: { bg: 'rgba(14,165,233,0.14)', fg: '#0369A1' },
  INSTALLATION_COMPLETE: { bg: 'rgba(6,182,212,0.14)', fg: '#0E7490' },
  NEED_TOUCH_UPS: { bg: 'rgba(217,70,239,0.14)', fg: '#A21CAF' },
  FINISHING_COMPLETE: { bg: 'rgba(20,184,166,0.14)', fg: '#0F766E' },
  ON_HOLD: { bg: 'rgba(249,115,22,0.16)', fg: '#C2410C' },
  COMPLETED: { bg: 'rgba(22,163,74,0.14)', fg: '#15803D' },
  CANCELLED: { bg: 'rgba(220,38,38,0.12)', fg: '#B91C1C' },
  INVOICED: { bg: 'rgba(168,85,247,0.14)', fg: '#7E22CE' },
}

const NEXT_ACTION_BY_STATUS: Record<string, string> = {
  QUOTE: 'Review quote and get it scheduled',
  SCHEDULED: 'Arrive on site and start the job',
  IN_PROGRESS: 'Continue work and update progress',
  MEASURED: 'Confirm measurements, then mark need to order',
  NEED_TO_ORDER: 'Order materials for this job',
  ORDERED: 'Wait for delivery, then schedule install',
  INSTALLATION_COMPLETE: 'Check for touch-ups or finishing',
  NEED_TOUCH_UPS: 'Complete punch list / touch-ups',
  FINISHING_COMPLETE: 'Close out and mark completed',
  ON_HOLD: 'Resolve blocker before continuing',
  COMPLETED: 'Job complete',
  CANCELLED: 'Job cancelled',
  INVOICED: 'Job invoiced',
}

function startOfLocalDay(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function endOfLocalDay(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999)
}

export function normalizeJobStatus(status: string | null | undefined) {
  return String(status || '').toUpperCase()
}

export function formatJobStatusLabel(status: string | null | undefined) {
  const key = normalizeJobStatus(status)
  return STATUS_LABELS[key] || key.replaceAll('_', ' ') || 'Unknown'
}

export function getProductionStage(status: string | null | undefined): ProductionStageId {
  const key = normalizeJobStatus(status)
  for (const stage of PRODUCTION_STAGES) {
    if (stage.statuses.includes(key)) return stage.id
  }
  return 'ready'
}

export function getProductionStageLabel(status: string | null | undefined) {
  const id = getProductionStage(status)
  return PRODUCTION_STAGES.find((s) => s.id === id)?.label || 'Ready'
}

export function getNextAction(job: Pick<Job, 'status' | 'scheduledStart'>): string {
  const status = normalizeJobStatus(job.status)
  if (status === 'SCHEDULED' && isScheduledToday(job.scheduledStart)) {
    return 'On today’s schedule — start when you arrive'
  }
  if (status === 'SCHEDULED' && isScheduledPast(job.scheduledStart)) {
    return 'Past scheduled date — start or reschedule'
  }
  return NEXT_ACTION_BY_STATUS[status] || 'Open job for details'
}

export function isTerminalStatus(status: string | null | undefined) {
  const key = normalizeJobStatus(status)
  return key === 'COMPLETED' || key === 'CANCELLED' || key === 'INVOICED'
}

export function isScheduledToday(scheduledStart: string | null | undefined) {
  if (!scheduledStart) return false
  const start = new Date(scheduledStart)
  if (Number.isNaN(start.getTime())) return false
  const dayStart = startOfLocalDay()
  const dayEnd = endOfLocalDay()
  return start >= dayStart && start <= dayEnd
}

export function isScheduledPast(scheduledStart: string | null | undefined) {
  if (!scheduledStart) return false
  const start = new Date(scheduledStart)
  if (Number.isNaN(start.getTime())) return false
  return start < startOfLocalDay()
}

/** Primary sort bucket (exclusive). */
export function getPrimaryQueue(job: Pick<Job, 'status' | 'scheduledStart'>): Exclude<WorkQueueId, 'all'> {
  const status = normalizeJobStatus(job.status)
  if (isTerminalStatus(status)) return 'done'
  if (jobMatchesQueue(job, 'do_now')) return 'do_now'
  if (jobMatchesQueue(job, 'today')) return 'today'
  return 'waiting'
}

export function jobMatchesQueue(
  job: Pick<Job, 'status' | 'scheduledStart'>,
  queue: WorkQueueId
): boolean {
  const status = normalizeJobStatus(job.status)
  if (queue === 'all') return !isTerminalStatus(status)
  if (queue === 'done') return isTerminalStatus(status)

  if (queue === 'do_now') {
    return (
      status === 'ON_HOLD' ||
      status === 'NEED_TO_ORDER' ||
      status === 'NEED_TOUCH_UPS' ||
      status === 'IN_PROGRESS' ||
      (status === 'SCHEDULED' && isScheduledPast(job.scheduledStart)) ||
      (status === 'SCHEDULED' && isScheduledToday(job.scheduledStart))
    )
  }

  if (queue === 'today') {
    return !isTerminalStatus(status) && isScheduledToday(job.scheduledStart)
  }

  // waiting: still open, not urgent do-now, not merely "on calendar today" unless also waiting on materials/etc.
  if (isTerminalStatus(status)) return false
  if (jobMatchesQueue(job, 'do_now')) return false
  return true
}

const QUEUE_SORT_RANK: Record<Exclude<WorkQueueId, 'all'>, number> = {
  do_now: 0,
  today: 1,
  waiting: 2,
  done: 3,
}

const STAGE_SORT_RANK: Record<ProductionStageId, number> = {
  blocked: 0,
  on_site: 1,
  ordering: 2,
  scheduled: 3,
  install: 4,
  finish: 5,
  ready: 6,
  done: 7,
}

export function sortJobsForProductionLine(jobs: Job[]) {
  return [...jobs].sort((a, b) => {
    const qa = getPrimaryQueue(a)
    const qb = getPrimaryQueue(b)
    if (QUEUE_SORT_RANK[qa] !== QUEUE_SORT_RANK[qb]) {
      return QUEUE_SORT_RANK[qa] - QUEUE_SORT_RANK[qb]
    }
    const sa = getProductionStage(a.status)
    const sb = getProductionStage(b.status)
    if (STAGE_SORT_RANK[sa] !== STAGE_SORT_RANK[sb]) {
      return STAGE_SORT_RANK[sa] - STAGE_SORT_RANK[sb]
    }
    const ta = a.scheduledStart ? new Date(a.scheduledStart).getTime() : Number.POSITIVE_INFINITY
    const tb = b.scheduledStart ? new Date(b.scheduledStart).getTime() : Number.POSITIVE_INFINITY
    if (ta !== tb) return ta - tb
    return String(a.jobNumber || '').localeCompare(String(b.jobNumber || ''))
  })
}

export function filterJobsForProductionLine(
  jobs: Job[],
  opts: { queue: WorkQueueId; stage: ProductionStageId | 'all' }
) {
  return sortJobsForProductionLine(jobs).filter((job) => {
    if (!jobMatchesQueue(job, opts.queue)) return false
    if (opts.stage !== 'all' && getProductionStage(job.status) !== opts.stage) return false
    return true
  })
}

export function countByQueue(jobs: Job[]) {
  const counts: Record<WorkQueueId, number> = {
    all: 0,
    do_now: 0,
    today: 0,
    waiting: 0,
    done: 0,
  }
  for (const job of jobs) {
    if (jobMatchesQueue(job, 'all')) counts.all += 1
    if (jobMatchesQueue(job, 'do_now')) counts.do_now += 1
    if (jobMatchesQueue(job, 'today')) counts.today += 1
    if (jobMatchesQueue(job, 'waiting')) counts.waiting += 1
    if (jobMatchesQueue(job, 'done')) counts.done += 1
  }
  return counts
}

export function countByStage(jobs: Job[]) {
  const counts = Object.fromEntries(PRODUCTION_STAGES.map((s) => [s.id, 0])) as Record<
    ProductionStageId,
    number
  >
  for (const job of jobs) {
    counts[getProductionStage(job.status)] += 1
  }
  return counts
}
