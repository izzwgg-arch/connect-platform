/**
 * Centralized dashboard route → permission mapping.
 * More specific prefixes must appear before broader ones.
 */

export interface RoutePermissionRule {
  prefix: string
  /** Single permission or any-of list */
  permission: string | string[]
}

export const ROUTE_PERMISSION_RULES: RoutePermissionRule[] = [
  { prefix: '/dashboard/settings/roles', permission: ['roles.access', 'roles.view'] },
  { prefix: '/dashboard/settings/integrations', permission: ['settings.access', 'settings.view', 'system.integrations'] },
  { prefix: '/dashboard/settings/branding', permission: 'settings.edit' },
  { prefix: '/dashboard/settings/email-integrations', permission: ['settings.access', 'settings.view', 'system.integrations'] },
  { prefix: '/dashboard/settings', permission: ['settings.access', 'settings.view'] },
  { prefix: '/dashboard/clients', permission: ['clients.access', 'clients.view', 'clients.create', 'clients.edit'] },
  { prefix: '/dashboard/requests', permission: ['leads.access', 'leads.view', 'leads.create', 'leads.edit'] },
  { prefix: '/dashboard/leads', permission: ['leads.access', 'leads.view', 'leads.create', 'leads.edit'] },
  { prefix: '/dashboard/measuring-requests', permission: ['leads.access', 'leads.view'] },
  { prefix: '/dashboard/jobs', permission: ['jobs.access', 'jobs.view', 'jobs.create', 'jobs.edit'] },
  { prefix: '/dashboard/schedule', permission: ['schedule.access', 'schedule.view', 'schedule.view_all'] },
  { prefix: '/dashboard/estimates/new', permission: ['estimates.create', 'estimates.access', 'estimates.view'] },
  { prefix: '/dashboard/estimates', permission: ['estimates.access', 'estimates.view', 'estimates.create', 'estimates.edit', 'estimates.send'] },
  { prefix: '/dashboard/invoices/new', permission: ['invoices.create', 'invoices.access', 'invoices.view'] },
  { prefix: '/dashboard/credit-memos/new', permission: ['invoices.create', 'invoices.access', 'invoices.view'] },
  { prefix: '/dashboard/credit-memos', permission: ['invoices.access', 'invoices.view', 'invoices.create', 'invoices.edit', 'invoices.send'] },
  { prefix: '/dashboard/invoices', permission: ['invoices.access', 'invoices.view', 'invoices.create', 'invoices.edit', 'invoices.send'] },
  { prefix: '/dashboard/purchase-orders', permission: ['purchase_orders.access', 'purchase_orders.view', 'purchase_orders.create'] },
  { prefix: '/dashboard/items', permission: ['settings.access', 'settings.view'] },
  { prefix: '/dashboard/vendors', permission: ['purchase_orders.access', 'purchase_orders.view'] },
  { prefix: '/dashboard/tasks', permission: ['tasks.access', 'tasks.view', 'tasks.create', 'tasks.edit'] },
  { prefix: '/dashboard/issues', permission: ['issues.access', 'issues.view', 'issues.create', 'issues.edit'] },
  { prefix: '/dashboard/teams', permission: ['teams.access', 'teams.view'] },
  { prefix: '/dashboard/calls', permission: ['calls.access', 'calls.view'] },
  { prefix: '/dashboard/messages', permission: ['messages.access', 'messages.view'] },
  { prefix: '/dashboard/email', permission: ['messages.access', 'messages.view'] },
  { prefix: '/dashboard/maps', permission: ['jobs.access', 'jobs.view'] },
  { prefix: '/dashboard/analytics', permission: ['analytics.access', 'analytics.view'] },
  { prefix: '/dashboard/reports/payments', permission: ['payments.access', 'payments.view'] },
  { prefix: '/dashboard/reports', permission: ['reports.access', 'reports.view'] },
  { prefix: '/dashboard/dispatch', permission: ['dispatch.access', 'dispatch.view'] },
  { prefix: '/dashboard/audit-logs', permission: ['audit_logs.access', 'audit_logs.view'] },
  { prefix: '/dashboard/help/new', permission: 'settings.edit' },
  { prefix: '/dashboard/help', permission: ['dashboard.access', 'dashboard.view'] },
  { prefix: '/dashboard/notifications', permission: ['dashboard.access', 'dashboard.view'] },
  { prefix: '/dashboard', permission: ['dashboard.access', 'dashboard.view'] },
]

const DOCUMENT_DETAIL_VIEW_RULES: Array<{
  base: string
  viewPermission: string
  exemptSegments: string[]
}> = [
  { base: '/dashboard/estimates/', viewPermission: 'estimates.view', exemptSegments: ['new'] },
  { base: '/dashboard/invoices/', viewPermission: 'invoices.view', exemptSegments: ['new'] },
  { base: '/dashboard/credit-memos/', viewPermission: 'invoices.view', exemptSegments: ['new'] },
  { base: '/dashboard/clients/', viewPermission: 'clients.view', exemptSegments: ['new'] },
  { base: '/dashboard/jobs/', viewPermission: 'jobs.view', exemptSegments: ['new'] },
  { base: '/dashboard/tasks/', viewPermission: 'tasks.view', exemptSegments: ['new'] },
  { base: '/dashboard/issues/', viewPermission: 'issues.view', exemptSegments: ['new'] },
  { base: '/dashboard/requests/', viewPermission: 'leads.view', exemptSegments: ['new'] },
  { base: '/dashboard/leads/', viewPermission: 'leads.view', exemptSegments: ['new'] },
]

/**
 * Resolve the required permission(s) for a dashboard pathname.
 * Returns null when the path is not a protected dashboard route.
 */
export function getRoutePermission(pathname: string): string | string[] | null {
  if (!pathname.startsWith('/dashboard')) {
    return null
  }

  for (const detail of DOCUMENT_DETAIL_VIEW_RULES) {
    if (pathname.startsWith(detail.base)) {
      const segment = pathname.slice(detail.base.length).split('/')[0]
      if (segment && !detail.exemptSegments.includes(segment)) {
        return detail.viewPermission
      }
    }
  }

  for (const rule of ROUTE_PERMISSION_RULES) {
    if (pathname === rule.prefix || pathname.startsWith(`${rule.prefix}/`)) {
      return rule.permission
    }
  }

  return ['dashboard.access', 'dashboard.view']
}