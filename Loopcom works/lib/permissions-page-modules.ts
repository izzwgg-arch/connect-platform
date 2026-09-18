import { PERMISSIONS, type PermissionDefinition } from '@/lib/permissions-catalog'

export interface PermissionSubPage {
  label: string
  description?: string
  permissionKey: string
}

export interface PermissionPageModule {
  id: string
  label: string
  /** Open the page / show in sidebar */
  pageAccessPermission: string
  /** Browse all documents on the page */
  viewPermission: string
  actionKeyPrefixes: string[]
  subPages?: PermissionSubPage[]
  /** Extra action keys outside prefix lists (e.g. payments under Reports) */
  extraActionKeys?: string[]
}

/**
 * Page-oriented permission groups aligned with sidebar navigation.
 */
export const PERMISSION_PAGE_MODULES: PermissionPageModule[] = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    pageAccessPermission: 'dashboard.access',
    viewPermission: 'dashboard.view',
    actionKeyPrefixes: ['dashboard.'],
  },
  {
    id: 'clients',
    label: 'Clients',
    pageAccessPermission: 'clients.access',
    viewPermission: 'clients.view',
    actionKeyPrefixes: ['clients.'],
  },
  {
    id: 'requests',
    label: 'Requests',
    pageAccessPermission: 'leads.access',
    viewPermission: 'leads.view',
    actionKeyPrefixes: ['leads.'],
  },
  {
    id: 'jobs',
    label: 'Jobs',
    pageAccessPermission: 'jobs.access',
    viewPermission: 'jobs.view',
    actionKeyPrefixes: ['jobs.'],
  },
  {
    id: 'production',
    label: 'Production',
    pageAccessPermission: 'production.access',
    viewPermission: 'production.view',
    actionKeyPrefixes: ['production.'],
  },
  {
    id: 'schedule',
    label: 'Schedule',
    pageAccessPermission: 'schedule.access',
    viewPermission: 'schedule.view',
    actionKeyPrefixes: ['schedule.'],
  },
  {
    id: 'estimates',
    label: 'Estimates',
    pageAccessPermission: 'estimates.access',
    viewPermission: 'estimates.view',
    actionKeyPrefixes: ['estimates.'],
  },
  {
    id: 'invoices',
    label: 'Invoices',
    pageAccessPermission: 'invoices.access',
    viewPermission: 'invoices.view',
    actionKeyPrefixes: ['invoices.'],
  },
  {
    id: 'purchase-orders',
    label: 'Purchase Orders',
    pageAccessPermission: 'purchase_orders.access',
    viewPermission: 'purchase_orders.view',
    actionKeyPrefixes: ['purchase_orders.'],
  },
  {
    id: 'tasks',
    label: 'Tasks',
    pageAccessPermission: 'tasks.access',
    viewPermission: 'tasks.view',
    actionKeyPrefixes: ['tasks.'],
  },
  {
    id: 'issues',
    label: 'Issues',
    pageAccessPermission: 'issues.access',
    viewPermission: 'issues.view',
    actionKeyPrefixes: ['issues.'],
  },
  {
    id: 'teams',
    label: 'Teams',
    pageAccessPermission: 'teams.access',
    viewPermission: 'teams.view',
    actionKeyPrefixes: ['teams.'],
  },
  {
    id: 'calls',
    label: 'Calls',
    pageAccessPermission: 'calls.access',
    viewPermission: 'calls.view',
    actionKeyPrefixes: ['calls.'],
  },
  {
    id: 'messages',
    label: 'Messages',
    pageAccessPermission: 'messages.access',
    viewPermission: 'messages.view',
    actionKeyPrefixes: ['messages.'],
  },
  {
    id: 'analytics',
    label: 'Analytics',
    pageAccessPermission: 'analytics.access',
    viewPermission: 'analytics.view',
    actionKeyPrefixes: ['analytics.'],
  },
  {
    id: 'reports',
    label: 'Reports',
    pageAccessPermission: 'reports.access',
    viewPermission: 'reports.view',
    actionKeyPrefixes: ['reports.'],
  },
  {
    id: 'payment-history',
    label: 'Payment History',
    pageAccessPermission: 'payments.access',
    viewPermission: 'payments.view',
    actionKeyPrefixes: ['payments.'],
  },
  {
    id: 'dispatch',
    label: 'Dispatch',
    pageAccessPermission: 'dispatch.access',
    viewPermission: 'dispatch.view',
    actionKeyPrefixes: ['dispatch.'],
  },
  {
    id: 'settings',
    label: 'Settings',
    pageAccessPermission: 'settings.access',
    viewPermission: 'settings.view',
    actionKeyPrefixes: ['settings.', 'system.'],
  },
  {
    id: 'users',
    label: 'Users (Settings)',
    pageAccessPermission: 'users.access',
    viewPermission: 'users.view',
    actionKeyPrefixes: ['users.'],
  },
  {
    id: 'roles',
    label: 'Roles (Settings)',
    pageAccessPermission: 'roles.access',
    viewPermission: 'roles.view',
    actionKeyPrefixes: ['roles.'],
  },
  {
    id: 'audit',
    label: 'Audit Logs',
    pageAccessPermission: 'audit_logs.access',
    viewPermission: 'audit_logs.view',
    actionKeyPrefixes: ['audit_logs.'],
  },
]

const MODULE_RESERVED_KEYS = (module: PermissionPageModule) =>
  new Set<string>([
    module.pageAccessPermission,
    module.viewPermission,
    ...(module.subPages || []).map((subPage) => subPage.permissionKey),
  ])

function permissionMatchesPrefixes(key: string, prefixes: string[]) {
  return prefixes.some((prefix) => key.startsWith(prefix))
}

export function getModuleActionPermissions(module: PermissionPageModule): PermissionDefinition[] {
  const reserved = MODULE_RESERVED_KEYS(module)
  const keys = new Set<string>()

  for (const perm of PERMISSIONS) {
    if (reserved.has(perm.key)) continue
    if (permissionMatchesPrefixes(perm.key, module.actionKeyPrefixes)) {
      keys.add(perm.key)
    }
  }

  for (const key of module.extraActionKeys || []) {
    if (!reserved.has(key)) keys.add(key)
  }

  return PERMISSIONS.filter((perm) => keys.has(perm.key))
}

export function getAllModulePermissionKeys(module: PermissionPageModule): string[] {
  const keys = new Set<string>([module.pageAccessPermission, module.viewPermission])
  for (const perm of getModuleActionPermissions(module)) {
    keys.add(perm.key)
  }
  for (const subPage of module.subPages || []) {
    keys.add(subPage.permissionKey)
  }
  return Array.from(keys)
}

export function isModulePageAccessEnabled(
  module: PermissionPageModule,
  selectedPermissions: string[]
): boolean {
  if (selectedPermissions.includes(module.pageAccessPermission)) return true
  // Legacy roles may only have *.view before *.access keys were added.
  if (module.id === 'payment-history' && selectedPermissions.includes(module.viewPermission)) {
    return true
  }
  return false
}

export function isModuleViewAllEnabled(
  module: PermissionPageModule,
  selectedPermissions: string[]
): boolean {
  return selectedPermissions.includes(module.viewPermission)
}

