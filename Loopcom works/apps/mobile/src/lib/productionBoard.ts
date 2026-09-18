/**
 * Production board — entirely derived from the existing Job.status, mirroring
 * the web app's lib/production/production-status.ts exactly (same 13 job
 * statuses, same stage/next-action/board mapping). Job.status remains the
 * single source of truth; nothing here is stored separately, so a status
 * change anywhere (web, this app, another mobile device) is reflected the
 * next time this screen re-fetches, with no extra sync step.
 *
 * This is intentionally separate from lib/productionLine.ts, which backs the
 * existing "Production Line" tab and uses a different, coarser 8-stage
 * grouping for a work-queue view. Do not merge the two — they serve
 * different screens with different taxonomies.
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
  isActive: boolean
  isOnHold: boolean
  isArchived: boolean
}

export const PRODUCTION_STATUS_MAP: Record<string, ProductionInfo> = {
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

export function getProductionInfo(status: string | null | undefined): ProductionInfo {
  const key = String(status || '').toUpperCase()
  return PRODUCTION_STATUS_MAP[key] || PRODUCTION_STATUS_MAP.QUOTE
}

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
