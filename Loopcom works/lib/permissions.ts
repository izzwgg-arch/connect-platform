// RBAC Permissions System
// Granular permissions for each module

export type Permission =
  | 'voip:use'
  | 'voip:view_logs'
  | 'sms:send'
  | 'sms:view'
  | 'email:send'
  | 'email:view'
  | 'quickbooks:connect'
  | 'quickbooks:sync'
  | 'quickbooks:view'
  | 'tasks:create'
  | 'tasks:assign'
  | 'tasks:view_all'
  | 'issues:create'
  | 'issues:assign'
  | 'issues:view_all'
  | 'clients:create'
  | 'clients:edit'
  | 'clients:delete'
  | 'clients:view_all'
  | 'jobs:create'
  | 'jobs:edit'
  | 'jobs:delete'
  | 'jobs:view_all'
  | 'invoices:create'
  | 'invoices:edit'
  | 'invoices:delete'
  | 'invoices:view_all'
  | 'payments:view'
  | 'payments:refund'
  | 'estimates:create'
  | 'estimates:edit'
  | 'estimates:delete'
  | 'estimates:view_all'
  | 'reports:view'
  | 'settings:manage'
  | 'users:invite'
  | 'users:edit'
  | 'users:delete'

// Default permissions by role
export const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  ADMIN: [
    'voip:use',
    'voip:view_logs',
    'sms:send',
    'sms:view',
    'email:send',
    'email:view',
    'quickbooks:connect',
    'quickbooks:sync',
    'quickbooks:view',
    'tasks:create',
    'tasks:assign',
    'tasks:view_all',
    'issues:create',
    'issues:assign',
    'issues:view_all',
    'clients:create',
    'clients:edit',
    'clients:delete',
    'clients:view_all',
    'jobs:create',
    'jobs:edit',
    'jobs:delete',
    'jobs:view_all',
    'invoices:create',
    'invoices:edit',
    'invoices:delete',
    'invoices:view_all',
    'payments:view',
    'payments:refund',
    'estimates:create',
    'estimates:edit',
    'estimates:delete',
    'estimates:view_all',
    'reports:view',
    'settings:manage',
    'users:invite',
    'users:edit',
    'users:delete',
  ],
  OFFICE: [
    'voip:use',
    'sms:send',
    'sms:view',
    'email:send',
    'email:view',
    'tasks:create',
    'tasks:assign',
    'tasks:view_all',
    'issues:create',
    'issues:assign',
    'issues:view_all',
    'clients:create',
    'clients:edit',
    'clients:view_all',
    'jobs:create',
    'jobs:edit',
    'jobs:view_all',
    'invoices:create',
    'invoices:edit',
    'invoices:view_all',
    'payments:view',
    'estimates:create',
    'estimates:edit',
    'estimates:view_all',
    'reports:view',
  ],
  MANAGER: [
    'voip:use',
    'sms:send',
    'sms:view',
    'email:send',
    'email:view',
    'tasks:create',
    'tasks:assign',
    'tasks:view_all',
    'issues:create',
    'issues:assign',
    'issues:view_all',
    'clients:create',
    'clients:edit',
    'clients:view_all',
    'jobs:create',
    'jobs:edit',
    'jobs:view_all',
    'invoices:create',
    'invoices:edit',
    'invoices:view_all',
    'payments:view',
    'estimates:create',
    'estimates:edit',
    'estimates:view_all',
    'reports:view',
  ],
  FIELD: [
    'sms:send',
    'sms:view',
    'tasks:create',
    'tasks:view_all',
    'issues:create',
    'clients:view_all',
    'jobs:view_all',
  ],
  SALES: [
    'voip:use',
    'sms:send',
    'sms:view',
    'email:send',
    'email:view',
    'tasks:create',
    'tasks:view_all',
    'clients:create',
    'clients:edit',
    'clients:view_all',
    'jobs:create',
    'jobs:view_all',
    'estimates:create',
    'estimates:edit',
    'estimates:view_all',
  ],
  ACCOUNTING: [
    'email:send',
    'email:view',
    'quickbooks:sync',
    'quickbooks:view',
    'clients:view_all',
    'invoices:create',
    'invoices:edit',
    'invoices:view_all',
    'payments:view',
    'payments:refund',
    'reports:view',
  ],
}

export function hasPermission(userPermissions: Permission[] | null, permission: Permission): boolean {
  if (!userPermissions) return false
  return userPermissions.includes(permission)
}

export function getDefaultPermissions(role: string): Permission[] {
  return ROLE_PERMISSIONS[role] || []
}
