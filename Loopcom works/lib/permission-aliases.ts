const DIRECT_ALIASES: Record<string, string[]> = {
  'payments.manage': ['manage_payments'],
  manage_payments: ['payments.manage'],
  'schedule.create': ['schedule_jobs'],
  schedule_jobs: ['schedule.create'],
  'jobs.edit': ['jobs.update'],
  'jobs.update': ['jobs.edit'],
  'schedule.edit': ['schedule.override_completed'],
  'schedule.override_completed': ['schedule.edit'],
}

function addIfMissing(target: string[], value: string) {
  if (!value) return
  if (!target.includes(value)) target.push(value)
}

export function getPermissionCandidates(permission: string): string[] {
  const trimmed = String(permission || '').trim()
  if (!trimmed) return []

  const candidates: string[] = []
  addIfMissing(candidates, trimmed)

  if (trimmed.includes(':')) {
    addIfMissing(candidates, trimmed.replace(/:/g, '.'))
  }
  if (trimmed.includes('.')) {
    addIfMissing(candidates, trimmed.replace(/\./g, ':'))
  }

  if (trimmed.endsWith('.view_all')) {
    addIfMissing(candidates, trimmed.replace(/\.view_all$/, '.view'))
  }
  if (trimmed.endsWith(':view_all')) {
    addIfMissing(candidates, trimmed.replace(/:view_all$/, ':view'))
  }

  for (const alias of DIRECT_ALIASES[trimmed] || []) {
    addIfMissing(candidates, alias)
  }

  return candidates
}

export function hasPermissionKey(availablePermissions: string[], requiredPermission: string): boolean {
  if (!Array.isArray(availablePermissions) || availablePermissions.length === 0) return false
  const candidates = getPermissionCandidates(requiredPermission)
  return candidates.some((candidate) => availablePermissions.includes(candidate))
}
