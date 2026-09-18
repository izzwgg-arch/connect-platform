import {
  PERMISSION_PAGE_MODULES,
  getModuleActionPermissions,
  type PermissionPageModule,
} from '@/lib/permissions-page-modules'
import { hasPermissionKey } from '@/lib/permission-aliases'

/** Sidebar visibility: Access page or View all only (not sub-pages/actions). */
export function getModuleSidebarPermissions(module: PermissionPageModule): string[] {
  return [module.pageAccessPermission, module.viewPermission]
}

export function hasModuleSidebarAccess(
  userPermissions: string[],
  module: PermissionPageModule
): boolean {
  return getModuleSidebarPermissions(module).some((key) =>
    hasPermissionKey(userPermissions, key)
  )
}

/** Route/page entry: access, view, actions, and sub-pages (legacy-friendly). */
export function getModulePageAccessCandidates(module: PermissionPageModule): string[] {
  const keys = new Set<string>([module.pageAccessPermission, module.viewPermission])

  for (const perm of getModuleActionPermissions(module)) {
    keys.add(perm.key)
  }

  for (const subPage of module.subPages || []) {
    keys.add(subPage.permissionKey)
  }

  for (const key of module.extraActionKeys || []) {
    keys.add(key)
  }

  return Array.from(keys)
}

export function hasModulePageAccess(
  userPermissions: string[],
  module: PermissionPageModule
): boolean {
  return getModulePageAccessCandidates(module).some((key) =>
    hasPermissionKey(userPermissions, key)
  )
}

export function hasModuleViewAll(
  userPermissions: string[],
  module: PermissionPageModule
): boolean {
  return hasPermissionKey(userPermissions, module.viewPermission)
}

export function getModuleById(moduleId: string): PermissionPageModule | undefined {
  return PERMISSION_PAGE_MODULES.find((module) => module.id === moduleId)
}

const ROUTE_MODULE_ID: Array<{ prefix: string; moduleId: string }> = [
  { prefix: '/dashboard/clients', moduleId: 'clients' },
  { prefix: '/dashboard/requests', moduleId: 'requests' },
  { prefix: '/dashboard/leads', moduleId: 'requests' },
  { prefix: '/dashboard/measuring-requests', moduleId: 'requests' },
  { prefix: '/dashboard/jobs', moduleId: 'jobs' },
  { prefix: '/dashboard/production', moduleId: 'production' },
  { prefix: '/dashboard/schedule', moduleId: 'schedule' },
  { prefix: '/dashboard/estimates', moduleId: 'estimates' },
  { prefix: '/dashboard/invoices', moduleId: 'invoices' },
  { prefix: '/dashboard/credit-memos', moduleId: 'invoices' },
  { prefix: '/dashboard/purchase-orders', moduleId: 'purchase-orders' },
  { prefix: '/dashboard/tasks', moduleId: 'tasks' },
  { prefix: '/dashboard/issues', moduleId: 'issues' },
  { prefix: '/dashboard/teams', moduleId: 'teams' },
  { prefix: '/dashboard/calls', moduleId: 'calls' },
  { prefix: '/dashboard/messages', moduleId: 'messages' },
  { prefix: '/dashboard/email', moduleId: 'messages' },
  { prefix: '/dashboard/analytics', moduleId: 'analytics' },
  { prefix: '/dashboard/reports/payments', moduleId: 'payment-history' },
  { prefix: '/dashboard/reports', moduleId: 'reports' },
  { prefix: '/dashboard/dispatch', moduleId: 'dispatch' },
  { prefix: '/dashboard/settings/roles', moduleId: 'roles' },
  { prefix: '/dashboard/settings', moduleId: 'settings' },
  { prefix: '/dashboard', moduleId: 'dashboard' },
]

const CREATE_ROUTE_RULES: Array<{ prefix: string; createPermission: string; moduleId: string }> = [
  { prefix: '/dashboard/estimates/new', createPermission: 'estimates.create', moduleId: 'estimates' },
  { prefix: '/dashboard/invoices/new', createPermission: 'invoices.create', moduleId: 'invoices' },
  { prefix: '/dashboard/credit-memos/new', createPermission: 'invoices.create', moduleId: 'invoices' },
  { prefix: '/dashboard/clients/new', createPermission: 'clients.create', moduleId: 'clients' },
  { prefix: '/dashboard/jobs/new', createPermission: 'jobs.create', moduleId: 'jobs' },
  { prefix: '/dashboard/tasks/new', createPermission: 'tasks.create', moduleId: 'tasks' },
  { prefix: '/dashboard/issues/new', createPermission: 'issues.create', moduleId: 'issues' },
]

export function getPageAccessPermissionsForPath(pathname: string): string[] | null {
  for (const rule of CREATE_ROUTE_RULES) {
    if (pathname === rule.prefix || pathname.startsWith(`${rule.prefix}/`)) {
      const module = getModuleById(rule.moduleId)
      if (!module) return [rule.createPermission]
      return [rule.createPermission, ...getModulePageAccessCandidates(module)]
    }
  }

  for (const rule of ROUTE_MODULE_ID) {
    if (pathname === rule.prefix || pathname.startsWith(`${rule.prefix}/`)) {
      const module = getModuleById(rule.moduleId)
      if (!module) return null
      return getModulePageAccessCandidates(module)
    }
  }

  return null
}

/** Sidebar nav item → page module id (when using page access permissions). */
export const SIDEBAR_PAGE_MODULE_IDS: Record<string, string> = {
  Dashboard: 'dashboard',
  Clients: 'clients',
  Requests: 'requests',
  Jobs: 'jobs',
  Production: 'production',
  Schedule: 'schedule',
  Estimates: 'estimates',
  Invoices: 'invoices',
  'Credit Memos': 'invoices',
  'Purchase Orders': 'purchase-orders',
  Items: 'settings',
  Vendors: 'purchase-orders',
  Tasks: 'tasks',
  Issues: 'issues',
  Teams: 'teams',
  Calls: 'calls',
  Messages: 'messages',
  Email: 'messages',
  Maps: 'jobs',
  Analytics: 'analytics',
  Reports: 'reports',
  'Payment History': 'payment-history',
  Dispatch: 'dispatch',
  'Audit Logs': 'audit',
  Settings: 'settings',
  Help: 'dashboard',
}
