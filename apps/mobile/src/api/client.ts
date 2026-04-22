import type { AuthResponse, CallRecord, VoiceExtension } from "../types";

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL || "https://app.connectcomunications.com/api";

async function parseJson(res: Response) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export async function login(email: string, password: string): Promise<AuthResponse> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  const json = await parseJson(res);
  if (!res.ok || !json?.token) throw new Error(json?.error || "LOGIN_FAILED");
  return json as AuthResponse;
}

export async function getVoiceExtension(token: string): Promise<VoiceExtension> {
  const res = await fetch(`${API_BASE}/voice/me/extension`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "VOICE_EXTENSION_FAILED");
  return json as VoiceExtension;
}

export async function resetSipPassword(token: string): Promise<{ sipPassword: string; provisioning: any }> {
  const res = await fetch(`${API_BASE}/voice/me/reset-sip-password`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({})
  });
  const json = await parseJson(res);
  if (!res.ok || !json?.sipPassword) throw new Error(json?.error || "SIP_RESET_FAILED");
  return json;
}

export async function getCallHistory(token: string): Promise<CallRecord[]> {
  const res = await fetch(`${API_BASE}/voice/me/calls`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "VOICE_CALLS_FAILED");
  return Array.isArray(json) ? (json as CallRecord[]) : [];
}

export async function registerMobileDevice(token: string, input: {
  platform: "IOS" | "ANDROID";
  expoPushToken: string;
  voipPushToken?: string;
  deviceName?: string;
}) {
  const res = await fetch(`${API_BASE}/mobile/devices/register`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "MOBILE_REGISTER_FAILED");
  return json;
}

export async function unregisterMobileDevice(token: string, expoPushToken?: string) {
  const res = await fetch(`${API_BASE}/mobile/devices/unregister`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(expoPushToken ? { expoPushToken } : {})
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "MOBILE_UNREGISTER_FAILED");
  return json;
}

export async function getPendingInvites(token: string) {
  const res = await fetch(`${API_BASE}/mobile/call-invites/pending`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "CALL_INVITE_FETCH_FAILED");
  return Array.isArray(json) ? json : [];
}

// ---- Multi-call -----------------------------------------------------------
// Invoked by CallSessionManager. These calls record stack-bookkeeping state
// on the server — the actual SIP hold/unhold happens client-side via JsSIP.

export async function getActiveAndHeldInvites(
  token: string,
): Promise<{ active: any | null; held: any[] }> {
  const res = await fetch(`${API_BASE}/mobile/call-invites/active`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "CALL_INVITE_ACTIVE_FAILED");
  return {
    active: json?.active ?? null,
    held: Array.isArray(json?.held) ? json.held : [],
  };
}

export async function holdCallInvite(token: string, inviteId: string) {
  const res = await fetch(`${API_BASE}/mobile/call-invites/${inviteId}/hold`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "CALL_INVITE_HOLD_FAILED");
  return json;
}

export async function resumeCallInvite(token: string, inviteId: string) {
  const res = await fetch(`${API_BASE}/mobile/call-invites/${inviteId}/resume`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "CALL_INVITE_RESUME_FAILED");
  return json;
}

export async function respondInvite(token: string, inviteId: string, action: "ACCEPT" | "DECLINE", deviceId?: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
  if (deviceId) headers["x-mobile-device-id"] = deviceId;
  const res = await fetch(`${API_BASE}/mobile/call-invites/${inviteId}/respond`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action })
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "CALL_INVITE_RESPOND_FAILED");
  return json;
}

export async function getMobileInviteAnswerStatus(token: string, inviteId: string) {
  const res = await fetch(`${API_BASE}/mobile/call-invites/${inviteId}/answer-status`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "CALL_INVITE_ANSWER_STATUS_FAILED");
  return json as {
    inviteId: string;
    linkedId: string | null;
    inviteStatus: string;
    pbxAnswered: boolean;
    answeredAt: string | null;
    telephonyState: string | null;
    activeChannels: string[];
  };
}



export async function redeemMobileProvisioningToken(token: string, input: { token: string; deviceInfo?: any; apiBaseUrl?: string }) {
  const base = (input.apiBaseUrl || API_BASE).replace(/\/$/, "");
  const res = await fetch(`${base}/voice/mobile-provisioning/redeem`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "MOBILE_PROVISIONING_REDEEM_FAILED");
  return json as { sipPassword: string; provisioning: any };
}

/** Unauthenticated — exchanges a QR-code token for a session JWT + SIP provisioning bundle.
 *  Used by the mobile app on first launch (no existing auth token).
 */
export async function exchangeQrToken(
  qrToken: string,
  deviceInfo?: { platform?: "IOS" | "ANDROID"; deviceName?: string; expoPushToken?: string; voipPushToken?: string },
  apiBaseUrl?: string
): Promise<{ sessionToken: string; sipPassword: string; provisioning: any; deviceId: string | null; user: { id: string; email: string; role: string } }> {
  const base = (apiBaseUrl || API_BASE).replace(/\/$/, "");
  const res = await fetch(`${base}/auth/mobile-qr-exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: qrToken, deviceInfo })
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "QR_EXCHANGE_FAILED");
  if (!json?.sessionToken) throw new Error("QR_EXCHANGE_NO_TOKEN");
  return json;
}

export async function startVoiceDiagSession(token: string, input: {
  sessionId?: string;
  platform: "WEB" | "IOS" | "ANDROID";
  deviceId?: string;
  appVersion?: string;
  sipWsUrl?: string;
  sipDomain?: string;
  iceHasTurn?: boolean;
  lastRegState?: string;
  lastCallState?: string;
  lastErrorCode?: string;
}) {
  const res = await fetch(`${API_BASE}/voice/diag/session/start`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "VOICE_DIAG_SESSION_START_FAILED");
  return json;
}

export async function heartbeatVoiceDiagSession(token: string, input: {
  sessionId: string;
  lastRegState?: string;
  lastCallState?: string;
  lastErrorCode?: string;
  iceHasTurn?: boolean;
  sipWsUrl?: string;
  sipDomain?: string;
}) {
  const res = await fetch(`${API_BASE}/voice/diag/session/heartbeat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "VOICE_DIAG_HEARTBEAT_FAILED");
  return json;
}

export async function postVoiceDiagEvent(token: string, input: {
  sessionId: string;
  type:
    | "SESSION_START"
    | "SESSION_HEARTBEAT"
    | "SIP_REGISTER"
    | "SIP_UNREGISTER"
    | "WS_CONNECTED"
    | "WS_DISCONNECTED"
    | "WS_RECONNECT"
    | "ICE_GATHERING"
    | "ICE_SELECTED_PAIR"
    | "TURN_TEST_RESULT"
    | "INCOMING_INVITE"
    | "ANSWER_TAPPED"
    | "CALL_CONNECTED"
    | "CALL_ENDED"
    | "ERROR"
    | "MEDIA_TEST_RUN"
    | "PUSH_RECEIVED"
    | "UI_SHOWN"
    | "INCOMING_PUSH_RECEIVED"
    | "CALLKEEP_UI_SHOWN"
    | "CALLKEEP_ANSWER_TAPPED"
    | "APP_FOREGROUNDED_FROM_CALL"
    | "INVITE_RESTORED"
    | "INVITE_RESTORE_FAILED"
    | "SIP_ANSWER_REQUESTED"
    | "SIP_ANSWER_SENT"
    | "SIP_ANSWER_CONFIRMED"
    | "SIP_ANSWER_FAILED"
    | "PBX_CALL_ANSWERED"
    | "PBX_STILL_RINGING_AFTER_ANSWER"
    | "ANSWER_DESYNC_DETECTED"
    | "UI_SWITCHED_TO_CONNECTING"
    | "UI_SWITCHED_TO_ACTIVE";
  payload?: any;
}) {
  const res = await fetch(`${API_BASE}/voice/diag/event`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "VOICE_DIAG_EVENT_FAILED");
  return json;
}


export async function startMediaTest(token: string, input?: { platform?: "WEB" | "IOS" | "ANDROID" }) {
  const res = await fetch(`${API_BASE}/voice/media-test/start`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(input || {})
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "MEDIA_TEST_START_FAILED");
  return json as { ok: boolean; runId: string; token: string; expiresAt: string; platform: "WEB" | "IOS" | "ANDROID" };
}

export async function reportMediaTest(token: string, input: {
  token: string;
  hasRelay: boolean;
  iceSelectedPairType: "host" | "srflx" | "relay" | "unknown";
  wsOk: boolean;
  sipRegisterOk: boolean;
  rtpCandidatePresent?: boolean;
  durationMs?: number;
  platform?: "WEB" | "IOS" | "ANDROID";
  errorCode?: string;
}) {
  const res = await fetch(`${API_BASE}/voice/media-test/report`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "MEDIA_TEST_REPORT_FAILED");
  return json;
}

export async function getMediaTestStatus(token: string) {
  const res = await fetch(`${API_BASE}/voice/media-test/status`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "MEDIA_TEST_STATUS_FAILED");
  return json;
}

export async function postCallQualityReport(token: string, report: Record<string, unknown>) {
  const res = await fetch(`${API_BASE}/voice/diag/call-quality-report`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(report),
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "CQR_FAILED");
  return json;
}

export async function postCallQualityPing(token: string, snapshot: Record<string, unknown>) {
  const res = await fetch(`${API_BASE}/voice/diag/call-quality-ping`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(snapshot),
  });
  // Non-fatal — don't throw on error
  return res.ok;
}

export async function clearCallQualityPing(token: string) {
  await fetch(`${API_BASE}/voice/diag/call-quality-ping/clear`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({}),
  }).catch(() => {});
}

export async function uploadCallFlightSession(token: string, body: {
  session: Record<string, unknown>;
  stats: Record<string, unknown>;
}) {
  const res = await fetch(`${API_BASE}/mobile/flight-recorder/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "FLIGHT_RECORDER_UPLOAD_FAILED");
  return json;
}

