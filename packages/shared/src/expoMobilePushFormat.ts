/**
 * Shared Expo Push API v2 message shaping for Connect mobile.
 *
 * Call-control pushes (INCOMING_CALL, wake, termination) stay strict data-only
 * + high priority — see apps/mobile IncomingCallFirebaseService.
 *
 * User-alert pushes (voicemail, missed_call, chat) use the same delivery class
 * (data-only + high priority) with display text carried inside `data` so FCM
 * always delivers to {@code onMessageReceived}; the Android native service posts
 * the visible notification when the app is not foregrounded.
 */

/** Payload `type` values that must never use Expo "notification" envelope. */
export const EXPO_PUSH_CALL_CONTROL_TYPES = new Set([
  "INCOMING_CALL",
  "INCOMING_CALL_WAKE",
  "INVITE_CLAIMED",
  "INVITE_CANCELED",
  "MISSED_CALL",
]);

/** Non-call alerts that must be reliable (same FCM class as call-control). */
export const EXPO_PUSH_USER_ALERT_TYPES = new Set(["voicemail", "missed_call", "dm_message", "sms_message"]);

export function stringifyFcmDataValues(data: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}

function channelIdForUserAlert(type: string): string {
  if (type === "voicemail") return "connect-voicemail";
  if (type === "missed_call") return "connect-missed-calls";
  if (type === "dm_message" || type === "sms_message") return "connect-messages";
  return "connect-messages";
}

function deriveUserAlertTitleBody(type: string, p: Record<string, unknown>): { title: string; body: string } {
  if (type === "voicemail") {
    const caller = String(p.callerNameOrNumber || "Unknown caller");
    return { title: "New voicemail", body: `Voicemail from ${caller}` };
  }
  if (type === "missed_call") {
    const caller = String(p.callerNameOrNumber || p.callerNumber || "Unknown caller");
    return { title: "Missed call", body: `Missed call from ${caller}` };
  }
  if (type === "dm_message") {
    const sender = String(p.senderName || "New message");
    const preview = String(p.preview || "Sent a message");
    return { title: sender, body: preview };
  }
  if (type === "sms_message") {
    const phone = String(p.phoneNumber || "SMS");
    const preview = String(p.preview || "Sent an attachment");
    return { title: phone, body: preview };
  }
  return { title: "Connect", body: "You have a new notification" };
}

/**
 * Builds one Expo `push/send` array element for a device token + logical payload.
 * Returned object is JSON-serializable (for fetch body).
 */
export function buildExpoPushV2Item(input: { to: string; payload: Record<string, unknown> }): Record<string, unknown> {
  const p = input.payload;
  const type = String(p.type || "");

  if (type === "INCOMING_CALL") {
    const data = stringifyFcmDataValues({
      type: p.type,
      inviteId: p.inviteId,
      callId: p.inviteId,
      from: p.fromNumber,
      fromNumber: p.fromNumber,
      fromDisplay: p.fromDisplay ?? "",
      toExtension: p.toExtension,
      tenantId: p.tenantId,
      timestamp: p.timestamp,
      pbxCallId: p.pbxCallId ?? "",
      sipCallTarget: p.sipCallTarget ?? "",
      pbxSipUsername: p.pbxSipUsername ?? "",
    });
    return { to: input.to, priority: "high", ttl: 45, data };
  }

  if (type === "INCOMING_CALL_WAKE") {
    const data = stringifyFcmDataValues({
      type: p.type,
      pbxCallId: p.pbxCallId,
      from: p.fromNumber,
      fromNumber: p.fromNumber,
      fromDisplay: p.fromDisplay ?? "",
      toExtension: p.toExtension,
      tenantId: p.tenantId,
      pbxVitalTenantId: p.pbxVitalTenantId ?? "",
      timestamp: p.timestamp,
      wakeRequestedAt: p.wakeRequestedAt,
    });
    return { to: input.to, priority: "high", ttl: 10, data };
  }

  if (type === "INVITE_CANCELED" || type === "INVITE_CLAIMED" || type === "MISSED_CALL") {
    const data = stringifyFcmDataValues({ ...p });
    return { to: input.to, priority: "high", ttl: 45, data };
  }

  if (EXPO_PUSH_USER_ALERT_TYPES.has(type)) {
    const { title, body } = deriveUserAlertTitleBody(type, p);
    const androidChannelId = channelIdForUserAlert(type);
    const data = stringifyFcmDataValues({
      ...p,
      alertTitle: title,
      alertBody: body,
      androidChannelId,
    });
    return {
      to: input.to,
      priority: "high",
      ttl: 3600,
      data,
    };
  }

  const data = stringifyFcmDataValues({ ...p });
  return { to: input.to, priority: "high", ttl: 300, data };
}
