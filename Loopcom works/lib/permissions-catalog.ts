/**
 * Comprehensive Permission Catalog
 * All granular permissions for the Trim Pro platform
 */

export interface PermissionDefinition {
  key: string
  label: string
  description: string
  category: string
  module: string
}

export const PERMISSIONS: PermissionDefinition[] = [
  // ============================================
  // DASHBOARD
  // ============================================
  {
    key: 'dashboard.access',
    label: 'Access Dashboard',
    description: 'Open the dashboard page (sidebar link)',
    category: 'Dashboard',
    module: 'dashboard',
  },
  {
    key: 'dashboard.view',
    label: 'View Dashboard',
    description: 'Access the main dashboard',
    category: 'Dashboard',
    module: 'dashboard',
  },

  // ============================================
  // CLIENTS
  // ============================================
  {
    key: 'clients.access',
    label: 'Access Clients Page',
    description: 'Open the clients page (sidebar link)',
    category: 'Clients',
    module: 'clients',
  },
  {
    key: 'clients.view',
    label: 'View All Clients',
    description: 'Browse the full client list and open client details',
    category: 'Clients',
    module: 'clients',
  },
  {
    key: 'clients.create',
    label: 'Create Clients',
    description: 'Create new client records',
    category: 'Clients',
    module: 'clients',
  },
  {
    key: 'clients.edit',
    label: 'Edit Clients',
    description: 'Edit existing client records',
    category: 'Clients',
    module: 'clients',
  },
  {
    key: 'clients.delete',
    label: 'Delete Clients',
    description: 'Delete client records',
    category: 'Clients',
    module: 'clients',
  },
  {
    key: 'clients.export',
    label: 'Export Clients',
    description: 'Export client data',
    category: 'Clients',
    module: 'clients',
  },

  // ============================================
  // LEADS
  // ============================================
  {
    key: 'leads.access',
    label: 'Access Requests Page',
    description: 'Open the requests/leads page (sidebar link)',
    category: 'Leads',
    module: 'leads',
  },
  {
    key: 'leads.view',
    label: 'View All Requests',
    description: 'Browse the full request list and open request details',
    category: 'Leads',
    module: 'leads',
  },
  {
    key: 'leads.create',
    label: 'Create Leads',
    description: 'Create new lead records',
    category: 'Leads',
    module: 'leads',
  },
  {
    key: 'leads.edit',
    label: 'Edit Leads',
    description: 'Edit existing lead records',
    category: 'Leads',
    module: 'leads',
  },
  {
    key: 'leads.delete',
    label: 'Delete Leads',
    description: 'Delete lead records',
    category: 'Leads',
    module: 'leads',
  },
  {
    key: 'leads.convert',
    label: 'Convert Leads',
    description: 'Convert leads to clients',
    category: 'Leads',
    module: 'leads',
  },
  {
    key: 'leads.export',
    label: 'Export Leads',
    description: 'Export lead data',
    category: 'Leads',
    module: 'leads',
  },

  // ============================================
  // JOBS
  // ============================================
  {
    key: 'jobs.access',
    label: 'Access Jobs Page',
    description: 'Open the jobs page (sidebar link)',
    category: 'Jobs',
    module: 'jobs',
  },
  {
    key: 'jobs.view',
    label: 'View All Jobs',
    description: 'Browse the full job list and open job details',
    category: 'Jobs',
    module: 'jobs',
  },
  {
    key: 'jobs.create',
    label: 'Create Jobs',
    description: 'Create new job records',
    category: 'Jobs',
    module: 'jobs',
  },
  {
    key: 'jobs.edit',
    label: 'Edit Jobs',
    description: 'Edit existing job records',
    category: 'Jobs',
    module: 'jobs',
  },
  {
    key: 'jobs.delete',
    label: 'Delete Jobs',
    description: 'Delete job records',
    category: 'Jobs',
    module: 'jobs',
  },
  {
    key: 'jobs.assign',
    label: 'Assign Jobs',
    description: 'Assign jobs to technicians',
    category: 'Jobs',
    module: 'jobs',
  },
  {
    key: 'jobs.reassign',
    label: 'Reassign Jobs',
    description: 'Reassign jobs to different technicians',
    category: 'Jobs',
    module: 'jobs',
  },
  {
    key: 'jobs.change_status',
    label: 'Change Job Status',
    description: 'Update job status',
    category: 'Jobs',
    module: 'jobs',
  },
  {
    key: 'jobs.add_notes',
    label: 'Add Job Notes',
    description: 'Add notes to jobs',
    category: 'Jobs',
    module: 'jobs',
  },
  {
    key: 'jobs.upload_files',
    label: 'Upload Job Files',
    description: 'Upload files to jobs',
    category: 'Jobs',
    module: 'jobs',
  },
  {
    key: 'web.jobs.set_hourly_billing',
    label: 'Set Hourly Billing',
    description: 'Enable hourly billing and edit hourly rate on jobs',
    category: 'Jobs',
    module: 'jobs',
  },
  {
    key: 'web.jobs.edit_time_entries',
    label: 'Edit Job Time Entries',
    description: 'Create, edit, and remove job time entries',
    category: 'Jobs',
    module: 'jobs',
  },
  {
    key: 'jobs.export',
    label: 'Export Jobs',
    description: 'Export job data',
    category: 'Jobs',
    module: 'jobs',
  },
  {
    key: 'jobs.access_all_types',
    label: 'Access All Job Types',
    description: 'View and manage jobs and requests of every job type, not only assigned types',
    category: 'Jobs',
    module: 'jobs',
  },

  // ============================================
  // PRODUCTION
  // ============================================
  {
    key: 'production.access',
    label: 'Access Production Page',
    description: 'Open the production page (sidebar link)',
    category: 'Production',
    module: 'production',
  },
  {
    key: 'production.view',
    label: 'View Production Board',
    description: 'View the production board and job production status, derived from job status',
    category: 'Production',
    module: 'production',
  },

  // ============================================
  // SCHEDULE / CALENDAR
  // ============================================
  {
    key: 'schedule.access',
    label: 'Access Schedule Page',
    description: 'Open the schedule page (sidebar link)',
    category: 'Schedule',
    module: 'schedule',
  },
  {
    key: 'schedule.view',
    label: 'View All Schedule',
    description: 'Browse the full calendar and schedule list',
    category: 'Schedule',
    module: 'schedule',
  },
  {
    key: 'schedule.view_all',
    label: 'View Entire Schedule',
    description: 'View the full schedule across all users and teams',
    category: 'Schedule',
    module: 'schedule',
  },
  {
    key: 'schedule.create',
    label: 'Create Schedule',
    description: 'Create schedule entries',
    category: 'Schedule',
    module: 'schedule',
  },
  {
    key: 'schedule.edit',
    label: 'Edit Schedule',
    description: 'Edit schedule entries',
    category: 'Schedule',
    module: 'schedule',
  },
  {
    key: 'schedule.delete',
    label: 'Delete Schedule',
    description: 'Delete schedule entries',
    category: 'Schedule',
    module: 'schedule',
  },
  {
    key: 'schedule.dispatch',
    label: 'Dispatch Schedule',
    description: 'Dispatch jobs from schedule',
    category: 'Schedule',
    module: 'schedule',
  },
  {
    key: 'schedule.reschedule',
    label: 'Reschedule',
    description: 'Reschedule jobs',
    category: 'Schedule',
    module: 'schedule',
  },

  // ============================================
  // ESTIMATES
  // ============================================
  {
    key: 'estimates.access',
    label: 'Access Estimates Page',
    description: 'Open the estimates page (sidebar link)',
    category: 'Estimates',
    module: 'estimates',
  },
  {
    key: 'estimates.view',
    label: 'View All Estimates',
    description: 'Browse the full estimate list and open existing estimates',
    category: 'Estimates',
    module: 'estimates',
  },
  {
    key: 'estimates.create',
    label: 'Create Estimates',
    description: 'Create new estimates',
    category: 'Estimates',
    module: 'estimates',
  },
  {
    key: 'estimates.edit',
    label: 'Edit Estimates',
    description: 'Edit existing estimates',
    category: 'Estimates',
    module: 'estimates',
  },
  {
    key: 'estimates.delete',
    label: 'Delete Estimates',
    description: 'Delete estimates',
    category: 'Estimates',
    module: 'estimates',
  },
  {
    key: 'estimates.send',
    label: 'Send Estimates',
    description: 'Send estimates to clients',
    category: 'Estimates',
    module: 'estimates',
  },
  {
    key: 'estimates.approve',
    label: 'Approve Estimates',
    description: 'Approve estimates',
    category: 'Estimates',
    module: 'estimates',
  },
  {
    key: 'estimates.convert',
    label: 'Convert Estimates',
    description: 'Convert estimates to jobs/invoices',
    category: 'Estimates',
    module: 'estimates',
  },
  {
    key: 'estimates.export',
    label: 'Export Estimates',
    description: 'Export estimate data',
    category: 'Estimates',
    module: 'estimates',
  },

  // ============================================
  // INVOICES
  // ============================================
  {
    key: 'invoices.access',
    label: 'Access Invoices Page',
    description: 'Open the invoices page (sidebar link)',
    category: 'Invoices',
    module: 'invoices',
  },
  {
    key: 'invoices.view',
    label: 'View All Invoices',
    description: 'Browse the full invoice list and open existing invoices',
    category: 'Invoices',
    module: 'invoices',
  },
  {
    key: 'invoices.create',
    label: 'Create Invoices',
    description: 'Create new invoices',
    category: 'Invoices',
    module: 'invoices',
  },
  {
    key: 'invoices.edit',
    label: 'Edit Invoices',
    description: 'Edit existing invoices',
    category: 'Invoices',
    module: 'invoices',
  },
  {
    key: 'invoices.delete',
    label: 'Delete Invoices',
    description: 'Delete invoices',
    category: 'Invoices',
    module: 'invoices',
  },
  {
    key: 'invoices.send',
    label: 'Send Invoices',
    description: 'Send invoices to clients',
    category: 'Invoices',
    module: 'invoices',
  },
  {
    key: 'invoices.refund',
    label: 'Refund Invoices',
    description: 'Process invoice refunds',
    category: 'Invoices',
    module: 'invoices',
  },
  {
    key: 'invoices.export',
    label: 'Export Invoices',
    description: 'Export invoice data',
    category: 'Invoices',
    module: 'invoices',
  },

  // ============================================
  // PURCHASE ORDERS
  // ============================================
  {
    key: 'purchase_orders.access',
    label: 'Access Purchase Orders Page',
    description: 'Open the purchase orders page (sidebar link)',
    category: 'Purchase Orders',
    module: 'purchase_orders',
  },
  {
    key: 'purchase_orders.view',
    label: 'View All Purchase Orders',
    description: 'Browse the full purchase order list and open details',
    category: 'Purchase Orders',
    module: 'purchase_orders',
  },
  {
    key: 'purchase_orders.create',
    label: 'Create Purchase Orders',
    description: 'Create new purchase orders',
    category: 'Purchase Orders',
    module: 'purchase_orders',
  },
  {
    key: 'purchase_orders.edit',
    label: 'Edit Purchase Orders',
    description: 'Edit existing purchase orders',
    category: 'Purchase Orders',
    module: 'purchase_orders',
  },
  {
    key: 'purchase_orders.delete',
    label: 'Delete Purchase Orders',
    description: 'Delete purchase orders',
    category: 'Purchase Orders',
    module: 'purchase_orders',
  },
  {
    key: 'purchase_orders.approve',
    label: 'Approve Purchase Orders',
    description: 'Approve purchase orders',
    category: 'Purchase Orders',
    module: 'purchase_orders',
  },
  {
    key: 'purchase_orders.export',
    label: 'Export Purchase Orders',
    description: 'Export purchase order data',
    category: 'Purchase Orders',
    module: 'purchase_orders',
  },

  // ============================================
  // TASKS
  // ============================================
  {
    key: 'tasks.access',
    label: 'Access Tasks Page',
    description: 'Open the tasks page (sidebar link)',
    category: 'Tasks',
    module: 'tasks',
  },
  {
    key: 'tasks.view',
    label: 'View All Tasks',
    description: 'Browse the full task list and open task details',
    category: 'Tasks',
    module: 'tasks',
  },
  {
    key: 'tasks.create',
    label: 'Create Tasks',
    description: 'Create new tasks',
    category: 'Tasks',
    module: 'tasks',
  },
  {
    key: 'tasks.edit',
    label: 'Edit Tasks',
    description: 'Edit existing tasks',
    category: 'Tasks',
    module: 'tasks',
  },
  {
    key: 'tasks.delete',
    label: 'Delete Tasks',
    description: 'Delete tasks',
    category: 'Tasks',
    module: 'tasks',
  },
  {
    key: 'tasks.assign',
    label: 'Assign Tasks',
    description: 'Assign tasks to users',
    category: 'Tasks',
    module: 'tasks',
  },
  {
    key: 'tasks.complete',
    label: 'Complete Tasks',
    description: 'Mark tasks as complete',
    category: 'Tasks',
    module: 'tasks',
  },

  // ============================================
  // ISSUES
  // ============================================
  {
    key: 'issues.access',
    label: 'Access Issues Page',
    description: 'Open the issues page (sidebar link)',
    category: 'Issues',
    module: 'issues',
  },
  {
    key: 'issues.view',
    label: 'View All Issues',
    description: 'Browse the full issue list and open issue details',
    category: 'Issues',
    module: 'issues',
  },
  {
    key: 'issues.create',
    label: 'Create Issues',
    description: 'Create new issues/tickets',
    category: 'Issues',
    module: 'issues',
  },
  {
    key: 'issues.edit',
    label: 'Edit Issues',
    description: 'Edit existing issues',
    category: 'Issues',
    module: 'issues',
  },
  {
    key: 'issues.delete',
    label: 'Delete Issues',
    description: 'Delete issues',
    category: 'Issues',
    module: 'issues',
  },
  {
    key: 'issues.assign',
    label: 'Assign Issues',
    description: 'Assign issues to users',
    category: 'Issues',
    module: 'issues',
  },
  {
    key: 'issues.close',
    label: 'Close Issues',
    description: 'Close/resolve issues',
    category: 'Issues',
    module: 'issues',
  },

  // ============================================
  // TEAMS
  // ============================================
  {
    key: 'teams.access',
    label: 'Access Teams Page',
    description: 'Open the teams page (sidebar link)',
    category: 'Teams',
    module: 'teams',
  },
  {
    key: 'teams.view',
    label: 'View All Teams',
    description: 'Browse the full team list and open team details',
    category: 'Teams',
    module: 'teams',
  },
  {
    key: 'teams.create',
    label: 'Create Teams',
    description: 'Create new teams',
    category: 'Teams',
    module: 'teams',
  },
  {
    key: 'teams.edit',
    label: 'Edit Teams',
    description: 'Edit existing teams',
    category: 'Teams',
    module: 'teams',
  },
  {
    key: 'teams.delete',
    label: 'Delete Teams',
    description: 'Delete teams',
    category: 'Teams',
    module: 'teams',
  },
  {
    key: 'teams.add_members',
    label: 'Add Team Members',
    description: 'Add members to teams',
    category: 'Teams',
    module: 'teams',
  },
  {
    key: 'teams.remove_members',
    label: 'Remove Team Members',
    description: 'Remove members from teams',
    category: 'Teams',
    module: 'teams',
  },

  // ============================================
  // CALLS
  // ============================================
  {
    key: 'calls.access',
    label: 'Access Calls Page',
    description: 'Open the calls page (sidebar link)',
    category: 'Communication',
    module: 'calls',
  },
  {
    key: 'calls.view',
    label: 'View All Calls',
    description: 'Browse the full call log',
    category: 'Communication',
    module: 'calls',
  },
  {
    key: 'calls.send',
    label: 'Make Calls',
    description: 'Make phone calls',
    category: 'Communication',
    module: 'calls',
  },
  {
    key: 'calls.delete',
    label: 'Delete Calls',
    description: 'Delete call records',
    category: 'Communication',
    module: 'calls',
  },
  {
    key: 'calls.export',
    label: 'Export Calls',
    description: 'Export call data',
    category: 'Communication',
    module: 'calls',
  },

  // ============================================
  // MESSAGES (SMS/Email)
  // ============================================
  {
    key: 'messages.access',
    label: 'Access Messages Page',
    description: 'Open the messages page (sidebar link)',
    category: 'Communication',
    module: 'messages',
  },
  {
    key: 'messages.view',
    label: 'View All Messages',
    description: 'Browse the full message history',
    category: 'Communication',
    module: 'messages',
  },
  {
    key: 'messages.send',
    label: 'Send Messages',
    description: 'Send SMS and email messages',
    category: 'Communication',
    module: 'messages',
  },
  {
    key: 'messages.delete',
    label: 'Delete Messages',
    description: 'Delete message records',
    category: 'Communication',
    module: 'messages',
  },
  {
    key: 'messages.export',
    label: 'Export Messages',
    description: 'Export message data',
    category: 'Communication',
    module: 'messages',
  },
  {
    key: 'messaging.sms',
    label: 'Send SMS',
    description: 'Send SMS messages via VoIP.ms',
    category: 'Communication',
    module: 'messaging',
  },
  {
    key: 'messaging.whatsapp',
    label: 'Send WhatsApp',
    description: 'Send WhatsApp messages',
    category: 'Communication',
    module: 'messaging',
  },
  {
    key: 'messaging.email',
    label: 'Send Email',
    description: 'Send email messages',
    category: 'Communication',
    module: 'messaging',
  },
  {
    key: 'integrations.manage',
    label: 'Manage Integrations',
    description: 'Configure and manage integrations',
    category: 'Settings',
    module: 'integrations',
  },

  // ============================================
  // SETTINGS
  // ============================================
  {
    key: 'settings.access',
    label: 'Access Settings Page',
    description: 'Open the settings page (sidebar link)',
    category: 'Settings',
    module: 'settings',
  },
  {
    key: 'settings.view',
    label: 'View All Settings',
    description: 'Browse and open settings sections',
    category: 'Settings',
    module: 'settings',
  },
  {
    key: 'settings.edit',
    label: 'Edit Settings',
    description: 'Edit system settings',
    category: 'Settings',
    module: 'settings',
  },

  // ============================================
  // USERS
  // ============================================
  {
    key: 'users.access',
    label: 'Access Users Page',
    description: 'Open the users page (sidebar link)',
    category: 'Users',
    module: 'users',
  },
  {
    key: 'users.view',
    label: 'View All Users',
    description: 'Browse the full user list and open user details',
    category: 'Users',
    module: 'users',
  },
  {
    key: 'users.create',
    label: 'Create Users',
    description: 'Create new user accounts',
    category: 'Users',
    module: 'users',
  },
  {
    key: 'users.edit',
    label: 'Edit Users',
    description: 'Edit existing user accounts',
    category: 'Users',
    module: 'users',
  },
  {
    key: 'users.deactivate',
    label: 'Deactivate Users',
    description: 'Deactivate user accounts',
    category: 'Users',
    module: 'users',
  },
  {
    key: 'users.reset_password',
    label: 'Reset User Passwords',
    description: 'Reset user passwords',
    category: 'Users',
    module: 'users',
  },

  // ============================================
  // ROLES
  // ============================================
  {
    key: 'roles.access',
    label: 'Access Roles Page',
    description: 'Open the roles page (sidebar link)',
    category: 'Roles',
    module: 'roles',
  },
  {
    key: 'roles.view',
    label: 'View All Roles',
    description: 'Browse the full role list and open role details',
    category: 'Roles',
    module: 'roles',
  },
  {
    key: 'roles.create',
    label: 'Create Roles',
    description: 'Create new custom roles',
    category: 'Roles',
    module: 'roles',
  },
  {
    key: 'roles.edit',
    label: 'Edit Roles',
    description: 'Edit existing roles',
    category: 'Roles',
    module: 'roles',
  },
  {
    key: 'roles.delete',
    label: 'Delete Roles',
    description: 'Delete custom roles',
    category: 'Roles',
    module: 'roles',
  },
  {
    key: 'roles.assign',
    label: 'Assign Roles',
    description: 'Assign roles to users',
    category: 'Roles',
    module: 'roles',
  },

  // ============================================
  // ANALYTICS
  // ============================================
  {
    key: 'analytics.access',
    label: 'Access Analytics Page',
    description: 'Open the analytics page (sidebar link)',
    category: 'Analytics',
    module: 'analytics',
  },
  {
    key: 'analytics.view',
    label: 'View All Analytics',
    description: 'Browse analytics dashboards and reports',
    category: 'Analytics',
    module: 'analytics',
  },

  // ============================================
  // REPORTS
  // ============================================
  {
    key: 'reports.access',
    label: 'Access Reports Page',
    description: 'Open the reports page (sidebar link)',
    category: 'Reports',
    module: 'reports',
  },
  {
    key: 'reports.view',
    label: 'View All Reports',
    description: 'Browse the full report list and open report details',
    category: 'Reports',
    module: 'reports',
  },
  {
    key: 'reports.create',
    label: 'Create Reports',
    description: 'Create new custom reports',
    category: 'Reports',
    module: 'reports',
  },
  {
    key: 'reports.edit',
    label: 'Edit Reports',
    description: 'Edit existing reports',
    category: 'Reports',
    module: 'reports',
  },
  {
    key: 'reports.delete',
    label: 'Delete Reports',
    description: 'Delete reports',
    category: 'Reports',
    module: 'reports',
  },
  {
    key: 'reports.run',
    label: 'Run Reports',
    description: 'Execute and view report results',
    category: 'Reports',
    module: 'reports',
  },
  {
    key: 'reports.schedule',
    label: 'Schedule Reports',
    description: 'Schedule automated report delivery',
    category: 'Reports',
    module: 'reports',
  },
  {
    key: 'reports.export',
    label: 'Export Reports',
    description: 'Export report data',
    category: 'Reports',
    module: 'reports',
  },
  {
    key: 'reports.share',
    label: 'Share Reports',
    description: 'Share reports with other users',
    category: 'Reports',
    module: 'reports',
  },

  // ============================================
  // DISPATCH
  // ============================================
  {
    key: 'dispatch.access',
    label: 'Access Dispatch Page',
    description: 'Open the dispatch page (sidebar link)',
    category: 'Dispatch',
    module: 'dispatch',
  },
  {
    key: 'dispatch.view',
    label: 'View All Dispatch',
    description: 'Browse the dispatch board and assignments',
    category: 'Dispatch',
    module: 'dispatch',
  },
  {
    key: 'dispatch.dispatch',
    label: 'Dispatch Jobs',
    description: 'Dispatch jobs to technicians',
    category: 'Dispatch',
    module: 'dispatch',
  },
  {
    key: 'dispatch.assign',
    label: 'Assign Jobs',
    description: 'Assign jobs via dispatch',
    category: 'Dispatch',
    module: 'dispatch',
  },
  {
    key: 'dispatch.route',
    label: 'Route Jobs',
    description: 'Plan and optimize job routes',
    category: 'Dispatch',
    module: 'dispatch',
  },
  {
    key: 'dispatch.notify',
    label: 'Send Notifications',
    description: 'Send dispatch notifications',
    category: 'Dispatch',
    module: 'dispatch',
  },
  {
    key: 'dispatch.override_lock',
    label: 'Override Locks',
    description: 'Override dispatch locks and conflicts',
    category: 'Dispatch',
    module: 'dispatch',
  },

  // ============================================
  // AUDIT LOGS
  // ============================================
  {
    key: 'audit_logs.access',
    label: 'Access Audit Logs Page',
    description: 'Open the audit logs page (sidebar link)',
    category: 'Audit',
    module: 'audit_logs',
  },
  {
    key: 'audit_logs.view',
    label: 'View All Audit Logs',
    description: 'Browse the full audit log list',
    category: 'Audit',
    module: 'audit_logs',
  },
  {
    key: 'audit_logs.export',
    label: 'Export Audit Logs',
    description: 'Export audit log data',
    category: 'Audit',
    module: 'audit_logs',
  },

  // ============================================
  // BILLING / PAYMENTS
  // ============================================
  {
    key: 'payments.access',
    label: 'Access Payment History Page',
    description: 'Show Payment History in sidebar and open the page',
    category: 'Billing',
    module: 'payments',
  },
  {
    key: 'payments.view',
    label: 'View Payment History',
    description: 'View payment records, receipts, and refund history',
    category: 'Billing',
    module: 'payments',
  },
  {
    key: 'payments.manage',
    label: 'Manage Payments',
    description: 'Process and manage payments',
    category: 'Billing',
    module: 'payments',
  },
  {
    key: 'payments.refund',
    label: 'Process Refunds',
    description: 'Process payment refunds',
    category: 'Billing',
    module: 'payments',
  },

  // ============================================
  // SYSTEM / INTEGRATIONS
  // ============================================
  {
    key: 'system.integrations',
    label: 'Manage Integrations',
    description: 'Manage third-party integrations',
    category: 'System',
    module: 'system',
  },
  {
    key: 'system.webhooks',
    label: 'Manage Webhooks',
    description: 'Manage webhook configurations',
    category: 'System',
    module: 'system',
  },
  {
    key: 'system.api_keys',
    label: 'Manage API Keys',
    description: 'Manage API keys and tokens',
    category: 'System',
    module: 'system',
  },

  // ============================================
  // MOBILE APP PERMISSIONS
  // ============================================
  {
    key: 'mobile.access',
    label: 'Access Mobile App',
    description: 'Can log into and use mobile app',
    category: 'Mobile App',
    module: 'mobile',
  },
  {
    key: 'mobile.jobs.view_assigned',
    label: 'View Assigned Jobs',
    description: 'Can view jobs assigned to them',
    category: 'Mobile App',
    module: 'mobile',
  },
  {
    key: 'mobile.jobs.view_all',
    label: 'View All Jobs',
    description: 'Can view all jobs in the organization (admin/dispatch style)',
    category: 'Mobile App',
    module: 'mobile',
  },
  {
    key: 'mobile.jobs.view_full',
    label: 'View Full Jobs Page',
    description: 'Can access the full jobs management page with search, filters, and all status options',
    category: 'Mobile App',
    module: 'mobile',
  },
  {
    key: 'mobile.jobs.assign',
    label: 'Assign Jobs',
    description: 'Can assign/reassign jobs to team members (admin/dispatch style)',
    category: 'Mobile App',
    module: 'mobile',
  },
  {
    key: 'mobile.jobs.complete',
    label: 'Complete Jobs',
    description: 'Can mark a job as completed',
    category: 'Mobile App',
    module: 'mobile',
  },
  {
    key: 'mobile.jobs.create',
    label: 'Create Jobs',
    description: 'Can create new jobs from the mobile app',
    category: 'Mobile App',
    module: 'mobile',
  },
  {
    key: 'mobile.jobs.edit',
    label: 'Edit Jobs',
    description: 'Can edit existing jobs from the mobile app',
    category: 'Mobile App',
    module: 'mobile',
  },
  {
    key: 'mobile.jobs.schedule',
    label: 'Schedule Jobs',
    description: 'Can set scheduled date and time for jobs from the mobile app',
    category: 'Mobile App',
    module: 'mobile',
  },
  {
    key: 'mobile.schedule.view_all',
    label: 'View Entire Schedule (Admin Scope)',
    description: 'Can view all scheduled jobs and events in mobile schedule calendar',
    category: 'Mobile App',
    module: 'mobile',
  },
  {
    key: 'canCreateSchedulesForOthers',
    label: 'Can create schedules for other employees (mobile)',
    description: 'Can create and assign schedule entries to other employees from mobile flows',
    category: 'Mobile App',
    module: 'mobile',
  },
  {
    key: 'mobile.jobs.status',
    label: 'Change Job Status',
    description: 'Can change job status from the mobile app',
    category: 'Mobile App',
    module: 'mobile',
  },
  {
    key: 'mobile.jobs.track_time',
    label: 'Track Job Time',
    description: 'Can start and stop timers on hourly jobs',
    category: 'Mobile App',
    module: 'mobile',
  },
  {
    key: 'mobile.jobs.edit_own_time_entries',
    label: 'Edit Own Time Entries',
    description: 'Can add and edit personal job time entries',
    category: 'Mobile App',
    module: 'mobile',
  },
  {
    key: 'mobile.jobs.edit_team_time_entries',
    label: 'Edit Team Time Entries',
    description: 'Can add and edit time entries for assigned team members',
    category: 'Mobile App',
    module: 'mobile',
  },
  {
    key: 'mobile.tasks.create',
    label: 'Create Tasks',
    description: 'Can create tasks from mobile',
    category: 'Mobile App',
    module: 'mobile',
  },
  {
    key: 'mobile.tasks.assign_to_admin',
    label: 'Assign Tasks to Admin',
    description: 'Can assign tasks to admin accounts (field worker -> admin)',
    category: 'Mobile App',
    module: 'mobile',
  },
  {
    key: 'mobile.tasks.assign_to_any',
    label: 'Assign Tasks to Any User',
    description: 'Can assign tasks to any user (admin)',
    category: 'Mobile App',
    module: 'mobile',
  },
  {
    key: 'mobile.issues.create',
    label: 'Create Issues',
    description: 'Can create issues from mobile',
    category: 'Mobile App',
    module: 'mobile',
  },
  {
    key: 'mobile.issues.assign_to_admin',
    label: 'Assign Issues to Admin',
    description: 'Can assign issues to admin accounts (field worker -> admin)',
    category: 'Mobile App',
    module: 'mobile',
  },
  {
    key: 'mobile.issues.assign_to_any',
    label: 'Assign Issues to Any User',
    description: 'Can assign issues to any user (admin)',
    category: 'Mobile App',
    module: 'mobile',
  },
  {
    key: 'mobile.messaging.enabled',
    label: 'Use Messaging',
    description: 'Can use job chat/messages',
    category: 'Mobile App',
    module: 'mobile',
  },
  {
    key: 'mobile.media.upload',
    label: 'Upload Media',
    description: 'Can upload photos/videos/files to jobs',
    category: 'Mobile App',
    module: 'mobile',
  },

  // Mobile Jobs — section visibility (info parity with web)
  {
    key: 'mobile.jobs.view_financials',
    label: 'View Job Financials',
    description: 'Can see job costs, estimates, invoiced totals, and open balances on mobile',
    category: 'Mobile App',
    module: 'mobile',
  },
  {
    key: 'mobile.jobs.view_documents',
    label: 'View Job Documents',
    description: 'Can see estimates, invoices, purchase orders, and payments on mobile job detail',
    category: 'Mobile App',
    module: 'mobile',
  },
  {
    key: 'mobile.jobs.view_billing',
    label: 'View Job Billing',
    description: 'Can see hourly billing settings and billable totals on mobile',
    category: 'Mobile App',
    module: 'mobile',
  },
  {
    key: 'mobile.jobs.view_time_entries',
    label: 'View Job Time Entries',
    description: 'Can see the full time entry list for a job on mobile',
    category: 'Mobile App',
    module: 'mobile',
  },
  {
    key: 'mobile.jobs.view_notes',
    label: 'View Job Notes',
    description: 'Can see job notes history on mobile',
    category: 'Mobile App',
    module: 'mobile',
  },
  {
    key: 'mobile.jobs.view_crew',
    label: 'View Job Crew',
    description: 'Can see full crew assignments on mobile',
    category: 'Mobile App',
    module: 'mobile',
  },
  {
    key: 'mobile.jobs.view_schedules',
    label: 'View Job Schedules',
    description: 'Can see schedule appointments linked to a job on mobile',
    category: 'Mobile App',
    module: 'mobile',
  },
  {
    key: 'mobile.jobs.view_client_details',
    label: 'View Job Client Details',
    description: 'Can see client company and contact details on mobile job detail',
    category: 'Mobile App',
    module: 'mobile',
  },
  {
    key: 'mobile.jobs.view_tasks_issues',
    label: 'View Job Tasks & Issues',
    description: 'Can see tasks and issues lists on mobile job detail',
    category: 'Mobile App',
    module: 'mobile',
  },

  // Mobile Requests — access + section visibility (info parity with web)
  {
    key: 'mobile.requests.view',
    label: 'View Requests',
    description: 'Can open Requests list and detail on the mobile app',
    category: 'Mobile App',
    module: 'mobile',
  },
  {
    key: 'mobile.requests.create',
    label: 'Create Requests',
    description: 'Can create requests from the mobile app',
    category: 'Mobile App',
    module: 'mobile',
  },
  {
    key: 'mobile.requests.edit',
    label: 'Edit Requests',
    description: 'Can edit requests from the mobile app',
    category: 'Mobile App',
    module: 'mobile',
  },
  {
    key: 'mobile.requests.assign',
    label: 'Assign Requests',
    description: 'Can assign field workers to requests on mobile',
    category: 'Mobile App',
    module: 'mobile',
  },
  {
    key: 'mobile.requests.view_financials',
    label: 'View Request Financials',
    description: 'Can see request value, probability, and expected value on mobile',
    category: 'Mobile App',
    module: 'mobile',
  },
  {
    key: 'mobile.requests.view_estimates',
    label: 'View Request Estimates',
    description: 'Can see estimates linked to a request on mobile',
    category: 'Mobile App',
    module: 'mobile',
  },
  {
    key: 'mobile.requests.view_communication',
    label: 'View Request Communication',
    description: 'Can see calls, SMS, and emails on mobile request detail',
    category: 'Mobile App',
    module: 'mobile',
  },
  {
    key: 'mobile.requests.view_activity',
    label: 'View Request Activity',
    description: 'Can see activity timeline on mobile request detail',
    category: 'Mobile App',
    module: 'mobile',
  },
  {
    key: 'mobile.requests.view_tasks_issues',
    label: 'View Request Tasks & Issues',
    description: 'Can see tasks and issues linked to a request on mobile',
    category: 'Mobile App',
    module: 'mobile',
  },
  {
    key: 'mobile.requests.view_converted_client',
    label: 'View Converted Client',
    description: 'Can see converted client info on mobile request detail',
    category: 'Mobile App',
    module: 'mobile',
  },
]

/**
 * Get all permissions grouped by category
 */
export function getPermissionsByCategory(): Record<string, PermissionDefinition[]> {
  const grouped: Record<string, PermissionDefinition[]> = {}
  for (const perm of PERMISSIONS) {
    if (!grouped[perm.category]) {
      grouped[perm.category] = []
    }
    grouped[perm.category].push(perm)
  }
  return grouped
}

/**
 * Get all permissions for a module
 */
export function getPermissionsByModule(module: string): PermissionDefinition[] {
  return PERMISSIONS.filter((p) => p.module === module)
}

/**
 * Get permission by key
 */
export function getPermission(key: string): PermissionDefinition | undefined {
  return PERMISSIONS.find((p) => p.key === key)
}
