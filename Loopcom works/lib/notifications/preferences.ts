import { NotificationType } from '@prisma/client'

export type NotificationPreferenceKey =
  | 'requestStatusChanges'
  | 'jobStatusChanges'
  | 'newMessage'
  | 'newJobAssigned'
  | 'paymentReceived'
  | 'emailNotifications'

export type UserNotificationPreferences = Record<NotificationPreferenceKey, boolean>

export const DEFAULT_NOTIFICATION_PREFERENCES: UserNotificationPreferences = {
  requestStatusChanges: true,
  jobStatusChanges: true,
  newMessage: true,
  newJobAssigned: true,
  paymentReceived: true,
  emailNotifications: false,
}

export function normalizeNotificationPreferences(raw: unknown): UserNotificationPreferences {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    requestStatusChanges:
      typeof source.requestStatusChanges === 'boolean'
        ? source.requestStatusChanges
        : DEFAULT_NOTIFICATION_PREFERENCES.requestStatusChanges,
    jobStatusChanges:
      typeof source.jobStatusChanges === 'boolean'
        ? source.jobStatusChanges
        : DEFAULT_NOTIFICATION_PREFERENCES.jobStatusChanges,
    newMessage:
      typeof source.newMessage === 'boolean'
        ? source.newMessage
        : DEFAULT_NOTIFICATION_PREFERENCES.newMessage,
    newJobAssigned:
      typeof source.newJobAssigned === 'boolean'
        ? source.newJobAssigned
        : DEFAULT_NOTIFICATION_PREFERENCES.newJobAssigned,
    paymentReceived:
      typeof source.paymentReceived === 'boolean'
        ? source.paymentReceived
        : DEFAULT_NOTIFICATION_PREFERENCES.paymentReceived,
    emailNotifications:
      typeof source.emailNotifications === 'boolean'
        ? source.emailNotifications
        : DEFAULT_NOTIFICATION_PREFERENCES.emailNotifications,
  }
}

export function preferenceKeyForNotification(
  type: NotificationType,
  linkType?: string | null
): Exclude<NotificationPreferenceKey, 'emailNotifications'> | null {
  if (type === 'MESSAGE_RECEIVED') return 'newMessage'
  if (type === 'JOB_ASSIGNED') return 'newJobAssigned'
  if (type === 'JOB_UPDATED') return 'jobStatusChanges'
  if (type === 'PAYMENT_RECEIVED') return 'paymentReceived'
  if (type === 'OTHER' && (linkType === 'request' || linkType === 'lead')) {
    return 'requestStatusChanges'
  }
  return null
}
