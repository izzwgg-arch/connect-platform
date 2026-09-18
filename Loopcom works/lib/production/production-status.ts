import type { JobStatusValue } from '@/lib/jobs/statuses'

/**
 * Production is a read-only, computed view of the existing Job Status.
 * There is no separate production status stored anywhere — Job.status
 * remains the single source of truth. Whenever a job's status changes
 * (from the Jobs page, the job detail page, Schedule, mobile, etc.),
 * everything below is re-derived on the next read. Nothing here needs
 * to be kept "in sync" because nothing here is ever independently stored.
 */

export type ProductionBoardColumn =
  | 'NOT_STARTED'
  | 'READY'
  | 'IN_PROGRESS'
  | 'MEASURED'
  | 'NEED_TO_ORDER'
  | 'ORDERED'
  | 'INSTALLATION_COMPLETE'
  | 'NEED_TOUCH_UPS'
  | 'FINISHING_COMPLETE'
  | 'ON_HOLD'
  | 'ARCHIVE'

export interface ProductionInfo {
  stage: string
  nextAction: string
  board: ProductionBoardColumn
  boardLabel: string
  /** In active production — excludes not-started (Quote), on hold, and archive. */
  isActive: boolean
  isOnHold: boolean
  isArchived: boolean
}

export const PRODUCTION_STATUS_MAP: Record<JobStatusValue, ProductionInfo> = {
  QUOTE: {
    stage: 'Not Started',
    nextAction: 'Wait for job approval',
    board: 'NOT_STARTED',
    boardLabel: 'Not Started',
    isActive: false,
    isOnHold: false,
    isArchived: false,
  },
  SCHEDULED: {
    stage: 'Ready to Start',
    nextAction: 'Begin production / assign job',
    board: 'READY',
    boardLabel: 'Ready',
    isActive: true,
    isOnHold: false,
    isArchived: false,
  },
  IN_PROGRESS: {
    stage: 'Production',
    nextAction: 'Continue production',
    board: 'IN_PROGRESS',
    boardLabel: 'In Progress',
    isActive: true,
    isOnHold: false,
    isArchived: false,
  },
  MEASURED: {
    stage: 'Measurement Complete',
    nextAction: 'Review measurements / prepare material order',
    board: 'MEASURED',
    boardLabel: 'Measured',
    isActive: true,
    isOnHold: false,
    isArchived: false,
  },
  NEED_TO_ORDER: {
    stage: 'Materials',
    nextAction: 'Order required materials',
    board: 'NEED_TO_ORDER',
    boardLabel: 'Need to Order',
    isActive: true,
    isOnHold: false,
    isArchived: false,
  },
  ORDERED: {
    stage: 'Materials Ordered',
    nextAction: 'Wait for materials',
    board: 'ORDERED',
    boardLabel: 'Ordered',
    isActive: true,
    isOnHold: false,
    isArchived: false,
  },
  INSTALLATION_COMPLETE: {
    stage: 'Installation Complete',
    nextAction: 'Review installation and check for touch-ups',
    board: 'INSTALLATION_COMPLETE',
    boardLabel: 'Installation Complete',
    isActive: true,
    isOnHold: false,
    isArchived: false,
  },
  NEED_TOUCH_UPS: {
    stage: 'Touch-Ups',
    nextAction: 'Complete required touch-ups',
    board: 'NEED_TOUCH_UPS',
    boardLabel: 'Need Touch-Ups',
    isActive: true,
    isOnHold: false,
    isArchived: false,
  },
  FINISHING_COMPLETE: {
    stage: 'Finishing Complete',
    nextAction: 'Final QC / complete job',
    board: 'FINISHING_COMPLETE',
    boardLabel: 'Finishing Complete',
    isActive: true,
    isOnHold: false,
    isArchived: false,
  },
  ON_HOLD: {
    stage: 'On Hold',
    nextAction: 'Resolve hold reason',
    board: 'ON_HOLD',
    boardLabel: 'On Hold',
    isActive: false,
    isOnHold: true,
    isArchived: false,
  },
  COMPLETED: {
    stage: 'Completed',
    nextAction: 'None',
    board: 'ARCHIVE',
    boardLabel: 'Completed',
    isActive: false,
    isOnHold: false,
    isArchived: true,
  },
  CANCELLED: {
    stage: 'Cancelled',
    nextAction: 'None',
    board: 'ARCHIVE',
    boardLabel: 'Cancelled',
    isActive: false,
    isOnHold: false,
    isArchived: true,
  },
  INVOICED: {
    stage: 'Invoiced',
    nextAction: 'None',
    board: 'ARCHIVE',
    boardLabel: 'Invoiced',
    isActive: false,
    isOnHold: false,
    isArchived: true,
  },
}

/** Falls back to the Quote mapping for any unrecognized/legacy status value. */
export function getProductionInfo(status: string): ProductionInfo {
  return PRODUCTION_STATUS_MAP[status as JobStatusValue] || PRODUCTION_STATUS_MAP.QUOTE
}

/** Ordered active board columns for the main Production board. On Hold and Archive render as separate sections. */
export const PRODUCTION_BOARD_COLUMNS: Array<{ id: ProductionBoardColumn; label: string }> = [
  { id: 'NOT_STARTED', label: 'Not Started' },
  { id: 'READY', label: 'Ready' },
  { id: 'IN_PROGRESS', label: 'In Progress' },
  { id: 'MEASURED', label: 'Measured' },
  { id: 'NEED_TO_ORDER', label: 'Need to Order' },
  { id: 'ORDERED', label: 'Ordered' },
  { id: 'INSTALLATION_COMPLETE', label: 'Installation Complete' },
  { id: 'NEED_TOUCH_UPS', label: 'Need Touch-Ups' },
  { id: 'FINISHING_COMPLETE', label: 'Finishing Complete' },
]

export const ARCHIVE_JOB_STATUSES: JobStatusValue[] = ['COMPLETED', 'CANCELLED', 'INVOICED']
