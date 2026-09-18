export type ScheduleScope = 'self' | 'all'

export interface ResolveScheduleScopeInput {
  requestedScope?: string | null
  requestedUserId?: string | null
  currentUserId: string
  canViewAll: boolean
}

export interface ResolveScheduleScopeResult {
  scope: ScheduleScope
  effectiveUserId?: string
}

export function resolveScheduleScope(input: ResolveScheduleScopeInput): ResolveScheduleScopeResult {
  const normalizedScope = (input.requestedScope || '').trim().toLowerCase()
  const normalizedUserId = (input.requestedUserId || '').trim()

  const asksForAll = normalizedScope === 'all' || normalizedUserId === 'all'
  if (asksForAll) {
    if (input.canViewAll) {
      return { scope: 'all' }
    }
    return { scope: 'self', effectiveUserId: input.currentUserId }
  }

  if (normalizedUserId) {
    if (normalizedUserId === input.currentUserId) {
      return { scope: 'self', effectiveUserId: input.currentUserId }
    }
    if (input.canViewAll) {
      return { scope: 'all', effectiveUserId: normalizedUserId }
    }
    return { scope: 'self', effectiveUserId: input.currentUserId }
  }

  if (input.canViewAll) {
    return { scope: 'all' }
  }

  return { scope: 'self', effectiveUserId: input.currentUserId }
}
