export type MobileNotificationRoute =
  | { type: 'voicemail'; voicemailId?: string; tenantId?: string; extensionId?: string }
  | { type: 'missed_call'; callId?: string; tenantId?: string; extensionId?: string; callerNumber?: string }
  | { type: 'dm_message' | 'sms_message'; conversationId: string; messageId?: string; tenantId?: string };

let activeChatThreadId: string | null = null;

export function setActiveNotificationChatThread(threadId: string | null) {
  activeChatThreadId = threadId;
}

// ─── Per-user notification isolation ──────────────────────────────────────────
// The identity of the user currently signed in on THIS device. Kept in a
// module-level slot (updated by NotificationsContext whenever the auth token
// changes) so the notification handler — which is registered at import time,
// outside React — can enforce per-user isolation synchronously.
export type NotificationIdentity = { userId: string | null; tenantId: string | null };

let currentIdentity: NotificationIdentity = { userId: null, tenantId: null };

export function setCurrentNotificationIdentity(identity: NotificationIdentity | null): void {
  currentIdentity = identity
    ? { userId: identity.userId ?? null, tenantId: identity.tenantId ?? null }
    : { userId: null, tenantId: null };
}

export function getCurrentNotificationIdentity(): NotificationIdentity {
  return currentIdentity;
}

/**
 * Hard per-user isolation guard.
 *
 * Returns false when a push is addressed to a DIFFERENT user or tenant than the
 * one currently signed in on this device. This is the last line of defence
 * against notification leakage: even if a stale / rotated / reassigned push
 * token ever delivers another user's notification to this phone, the app
 * refuses to show or act on it.
 *
 * Deliberately conservative — it only BLOCKS on a *positive* mismatch (both the
 * payload field and the signed-in value are known and differ). When the payload
 * carries no recipient identity (older server build) or we don't yet know the
 * signed-in identity (cold start before the token is decoded), it ALLOWS, so a
 * user never loses their own notifications.
 */
export function isNotificationForCurrentUser(
  data: any,
  identity: NotificationIdentity = currentIdentity,
): boolean {
  const recipientUserId =
    data?.recipientUserId != null
      ? String(data.recipientUserId)
      : data?.toUserId != null
        ? String(data.toUserId)
        : '';
  if (recipientUserId && identity.userId && recipientUserId !== String(identity.userId)) {
    return false;
  }
  const payloadTenant = data?.tenantId != null ? String(data.tenantId) : '';
  if (payloadTenant && identity.tenantId && payloadTenant !== String(identity.tenantId)) {
    return false;
  }
  return true;
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
  // Per-user isolation: never surface an alert addressed to another user.
  if (!isNotificationForCurrentUser(data)) return false;
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
