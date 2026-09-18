import { useAuth } from '../auth/AuthContext'

/**
 * Hook to check mobile permissions
 */
export function useMobilePermissions() {
  const { mobilePermissions, permissions, user } = useAuth()

  const hasPermission = (permission: string): boolean => {
    return mobilePermissions.includes(permission)
  }

  const hasWebPermission = (permission: string): boolean => {
    return permissions.includes(permission)
  }

  const hasAnyPermission = (permissionsList: string[]): boolean => {
    return permissionsList.some((perm) => mobilePermissions.includes(perm))
  }

  const hasAllPermissions = (permissionsList: string[]): boolean => {
    return permissionsList.every((perm) => mobilePermissions.includes(perm))
  }

  const canViewAllJobs = (): boolean => hasPermission('mobile.jobs.view_all')
  const canAssignJobs = (): boolean => hasPermission('mobile.jobs.assign')
  const canCompleteJobs = (): boolean => hasPermission('mobile.jobs.complete')
  const canCreateJobs = (): boolean => hasPermission('mobile.jobs.create')
  const canEditJobs = (): boolean => hasPermission('mobile.jobs.edit')
  const canScheduleJobs = (): boolean => hasPermission('mobile.jobs.schedule')
  const canChangeJobStatus = (): boolean => hasPermission('mobile.jobs.status')
  const canCreateTasks = (): boolean => hasPermission('mobile.tasks.create')
  const canAssignTasksToAdmin = (): boolean =>
    hasPermission('mobile.tasks.assign_to_admin') || hasPermission('mobile.tasks.assign_to_any')
  const canAssignTasksToAny = (): boolean => hasPermission('mobile.tasks.assign_to_any')
  const canViewAllTasks = (): boolean =>
    user?.role === 'ADMIN' || hasWebPermission('tasks.assign') || canAssignTasksToAny()
  const canCreateIssues = (): boolean => hasPermission('mobile.issues.create')
  const canAssignIssuesToAdmin = (): boolean =>
    hasPermission('mobile.issues.assign_to_admin') || hasPermission('mobile.issues.assign_to_any')
  const canAssignIssuesToAny = (): boolean => hasPermission('mobile.issues.assign_to_any')
  const canUploadMedia = (): boolean => hasPermission('mobile.media.upload')
  const canUseMessaging = (): boolean => hasPermission('mobile.messaging.enabled')
  const canTrackTime = (): boolean => hasPermission('mobile.jobs.track_time')
  const canCreateSchedulesForOthers = (): boolean => hasPermission('canCreateSchedulesForOthers')
  const canViewEntireSchedule = (): boolean =>
    hasPermission('mobile.schedule.view_all') ||
    hasPermission('canCreateSchedulesForOthers') ||
    hasPermission('mobile.jobs.assign')
  const canEditOwnTimeEntries = (): boolean => hasPermission('mobile.jobs.edit_own_time_entries')
  const canEditTeamTimeEntries = (): boolean => hasPermission('mobile.jobs.edit_team_time_entries')
  const hasMobileAccess = (): boolean => hasPermission('mobile.access')

  // Jobs section visibility
  const canViewJobFinancials = (): boolean => hasPermission('mobile.jobs.view_financials')
  const canViewJobDocuments = (): boolean => hasPermission('mobile.jobs.view_documents')
  const canViewJobBilling = (): boolean => hasPermission('mobile.jobs.view_billing')
  const canViewJobTimeEntries = (): boolean => hasPermission('mobile.jobs.view_time_entries')
  const canViewJobNotes = (): boolean => hasPermission('mobile.jobs.view_notes')
  const canViewJobCrew = (): boolean => hasPermission('mobile.jobs.view_crew')
  const canViewJobSchedules = (): boolean => hasPermission('mobile.jobs.view_schedules')
  const canViewJobClientDetails = (): boolean => hasPermission('mobile.jobs.view_client_details')
  const canViewJobTasksIssues = (): boolean => hasPermission('mobile.jobs.view_tasks_issues')

  // Requests
  const canViewRequests = (): boolean => hasPermission('mobile.requests.view')
  const canCreateRequests = (): boolean => hasPermission('mobile.requests.create')
  const canEditRequests = (): boolean => hasPermission('mobile.requests.edit')
  const canAssignRequests = (): boolean => hasPermission('mobile.requests.assign')
  const canViewRequestFinancials = (): boolean => hasPermission('mobile.requests.view_financials')
  const canViewRequestEstimates = (): boolean => hasPermission('mobile.requests.view_estimates')
  const canViewRequestCommunication = (): boolean => hasPermission('mobile.requests.view_communication')
  const canViewRequestActivity = (): boolean => hasPermission('mobile.requests.view_activity')
  const canViewRequestTasksIssues = (): boolean => hasPermission('mobile.requests.view_tasks_issues')
  const canViewRequestConvertedClient = (): boolean => hasPermission('mobile.requests.view_converted_client')

  return {
    permissions: mobilePermissions,
    webPermissions: permissions,
    hasPermission,
    hasWebPermission,
    hasAnyPermission,
    hasAllPermissions,
    canViewAllJobs,
    canAssignJobs,
    canCompleteJobs,
    canCreateJobs,
    canEditJobs,
    canScheduleJobs,
    canChangeJobStatus,
    canCreateTasks,
    canAssignTasksToAdmin,
    canAssignTasksToAny,
    canViewAllTasks,
    canCreateIssues,
    canAssignIssuesToAdmin,
    canAssignIssuesToAny,
    canUploadMedia,
    canUseMessaging,
    canTrackTime,
    canCreateSchedulesForOthers,
    canViewEntireSchedule,
    canEditOwnTimeEntries,
    canEditTeamTimeEntries,
    hasMobileAccess,
    canViewJobFinancials,
    canViewJobDocuments,
    canViewJobBilling,
    canViewJobTimeEntries,
    canViewJobNotes,
    canViewJobCrew,
    canViewJobSchedules,
    canViewJobClientDetails,
    canViewJobTasksIssues,
    canViewRequests,
    canCreateRequests,
    canEditRequests,
    canAssignRequests,
    canViewRequestFinancials,
    canViewRequestEstimates,
    canViewRequestCommunication,
    canViewRequestActivity,
    canViewRequestTasksIssues,
    canViewRequestConvertedClient,
  }
}
