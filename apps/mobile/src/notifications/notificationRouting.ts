export type MobileNotificationRoute =
  | { type: 'voicemail'; voicemailId?: string; tenantId?: string; extensionId?: string }
  | { type: 'missed_call'; callId?: string; tenantId?: string; extensionId?: string; callerNumber?: string }
  | { type: 'dm_message' | 'sms_message'; conversationId: string; messageId?: string; tenantId?: string };

let activeChatThreadId: string | null = null;

export function setActiveNotificationChatThread(threadId: string | null) {
  activeChatThreadId = threadId;
}

export function shouldSuppressForegroundPush(data: any): boolean {
  const type = String(data?.type || '');
  if ((type === 'dm_message' || type === 'sms_message') && activeChatThreadId) {
    return String(data?.conversationId || '') === activeChatThreadId;
  }
  return false;
}

const USER_ALERT_TYPES = new Set(['voicemail', 'missed_call', 'dm_message', 'sms_message']);

export function isUserAlertPushType(type: string | undefined | null): boolean {
  return USER_ALERT_TYPES.has(String(type || ''));
}

/**
 * Decide whether the foreground push listener should present a local
 * notification for a user-facing alert (voicemail / chat / missed call).
 *
 * The native FCM service skips the tray while the app is foreground, and a
 * strict data-only push has no OS-rendered banner — so without an explicit
 * local notification these alerts are silently dropped while the app is open.
 *
 * Returns false when:
 *  - the push is not a user-alert type
 *  - there is no human-readable alertTitle to show
 *  - this is the re-entrant local notification we already presented
 *  - the push already carried an OS-rendered notification block (avoid dup)
 *  - the alert is for the chat thread the user is actively viewing
 */
export function shouldPresentForegroundUserAlert(data: any, hasOsContent: boolean): boolean {
  if (!isUserAlertPushType(data?.type)) return false;
  if (!data?.alertTitle) return false;
  if (data?._localPresented === true || data?._localPresented === 'true') return false;
  if (hasOsContent) return false;
  if (shouldSuppressForegroundPush(data)) return false;
  return true;
}

/** Resolve the Android channel for a user-alert push, with type-based fallback. */
export function userAlertChannelId(data: any): string {
  const explicit = data?.androidChannelId ? String(data.androidChannelId) : '';
  if (explicit) return explicit;
  const type = String(data?.type || '');
  if (type === 'voicemail') return 'connect-voicemail';
  if (type === 'missed_call') return 'connect-missed-calls';
  return 'connect-messages';
}

export function notificationDataToRoute(data: any): MobileNotificationRoute | null {
  const type = String(data?.type || '');
  if (type === 'voicemail') {
    return {
      type: 'voicemail',
      voicemailId: data?.voicemailId ? String(data.voicemailId) : undefined,
      tenantId: data?.tenantId ? String(data.tenantId) : undefined,
      extensionId: data?.extensionId ? String(data.extensionId) : undefined,
    };
  }
  if (type === 'missed_call') {
    return {
      type: 'missed_call',
      callId: data?.callId ? String(data.callId) : undefined,
      tenantId: data?.tenantId ? String(data.tenantId) : undefined,
      extensionId: data?.extensionId ? String(data.extensionId) : undefined,
      callerNumber: data?.callerNumber ? String(data.callerNumber) : undefined,
    };
  }
  if (type === 'dm_message' || type === 'sms_message') {
    const conversationId = String(data?.conversationId || '');
    if (!conversationId) return null;
    return {
      type,
      conversationId,
      messageId: data?.messageId ? String(data.messageId) : undefined,
      tenantId: data?.tenantId ? String(data.tenantId) : undefined,
    };
  }
  return null;
}
