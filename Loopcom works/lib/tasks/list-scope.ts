import { hasPermissionKey } from '@/lib/permission-aliases'

export type TasksListFilter = 'all' | 'my' | 'assigned'

/** Personal task inbox on the main Tasks page (My Tasks default, All Tasks for managers). */
export function isPersonalTasksListEnabled(): boolean {
  return true
}

export function defaultTasksListFilter(): TasksListFilter {
  return isPersonalTasksListEnabled() ? 'my' : 'all'
}

export function canViewAllTasksList(input: {
  role?: string | null
  permissions?: string[]
}): boolean {
  if (!isPersonalTasksListEnabled()) return true
  if (input.role === 'ADMIN') return true
  return hasPermissionKey(input.permissions ?? [], 'tasks.assign')
}

export function resolveTasksListFilter(
  requested: string | null | undefined,
  input: { role?: string | null; permissions?: string[] }
): TasksListFilter {
  const normalized = (requested || defaultTasksListFilter()) as TasksListFilter
  const filter: TasksListFilter =
    normalized === 'all' || normalized === 'my' || normalized === 'assigned'
      ? normalized
      : defaultTasksListFilter()

  if (filter === 'all' && !canViewAllTasksList(input)) {
    return defaultTasksListFilter()
  }

  return filter
}
