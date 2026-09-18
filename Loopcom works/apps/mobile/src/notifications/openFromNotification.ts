import * as Linking from 'expo-linking'

type NotificationPayload = Record<string, any>

export function resolveDeepLinkFromNotificationPayload(payload: NotificationPayload): string | null {
  const deepLink = typeof payload.deepLink === 'string' ? payload.deepLink : null
  if (deepLink) return deepLink

  const directUrl = typeof payload.url === 'string' ? payload.url : null
  if (directUrl && (/^https?:\/\//i.test(directUrl) || directUrl.startsWith('trimpro://') || directUrl.startsWith('trimprofield://'))) {
    return directUrl
  }

  const linkType = typeof payload.linkType === 'string' ? payload.linkType : ''
  const linkId = typeof payload.linkId === 'string' ? payload.linkId : ''

  if ((linkType === 'message' || linkType === 'conversation') && linkId) return `trimpro://messages/${linkId}`
  if (linkType === 'job' && linkId) return `trimpro://jobs/${linkId}`
  if (linkType === 'task' && linkId) return `trimpro://tasks/${linkId}`
  if (linkType === 'issue' && linkId) return `trimpro://issues/${linkId}`
  if (linkType === 'request' && linkId) return `trimpro://requests/${linkId}`
  if (linkType === 'lead' && linkId) return `trimpro://requests/${linkId}`
  if (linkType === 'measuring_request' && linkId) return `trimpro://measuring-requests/${linkId}`
  if (linkType === 'schedule') return 'trimpro://schedule'

  return null
}

export async function openFromNotificationPayload(payload: NotificationPayload): Promise<boolean> {
  const target = resolveDeepLinkFromNotificationPayload(payload)
  if (!target) return false
  await Linking.openURL(target)
  return true
}
