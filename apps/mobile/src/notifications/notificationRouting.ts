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
