import type {
  AuthResponse,
  CallRecord,
  ChatDirectoryUser,
  ChatMessage,
  ChatThread,
  ContactsResponse,
  TeamDirectoryMember,
  VoiceExtension,
  Voicemail,
  VoicemailFolder,
  VoicemailResponse,
} from "../types";

export const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL || "https://app.connectcomunications.com/api";

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

export const mobileQueryKeys = {
  callHistory: ["mobile", "callHistory"] as const,
  voicemails: (folder: VoicemailFolder | "all" = "all") => ["mobile", "voicemails", folder] as const,
  teamDirectory: ["mobile", "teamDirectory"] as const,
  contacts: (query = "") => ["mobile", "contacts", query] as const,
  chatThreads: ["mobile", "chatThreads"] as const,
  chatMessages: (threadId: string) => ["mobile", "chatMessages", threadId] as const,
};

export async function getVoicemails(
  token: string,
  input: { folders?: VoicemailFolder[]; page?: number } = {},
): Promise<{ voicemails: Voicemail[]; totals: Record<VoicemailFolder, number> }> {
  const folders = input.folders ?? ["inbox", "urgent", "old"];
  const page = input.page ?? 1;
  const responses = await Promise.all(
    folders.map(async (folder) => {
      const params = new URLSearchParams({ folder, page: String(page) });
      const res = await fetch(`${API_BASE}/voice/voicemail?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await parseJson(res);
      if (!res.ok) throw new Error(json?.error || "VOICEMAIL_FAILED");
      return { folder, data: json as VoicemailResponse };
    }),
  );
  const totals = { inbox: 0, urgent: 0, old: 0 } as Record<VoicemailFolder, number>;
  const seen = new Set<string>();
  const voicemails: Voicemail[] = [];
  for (const { folder, data } of responses) {
    totals[folder] = data.total ?? 0;
    for (const vm of data.voicemails ?? []) {
      if (seen.has(vm.id)) continue;
      seen.add(vm.id);
      voicemails.push({
        ...vm,
        streamUrl: vm.streamUrl ?? `${API_BASE}/voice/voicemail/${encodeURIComponent(vm.id)}/stream?token=${encodeURIComponent(token)}`,
      });
    }
  }
  voicemails.sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
  return { voicemails, totals };
}

export async function markVoicemailListened(token: string, id: string, listened: boolean) {
  const res = await fetch(`${API_BASE}/voice/voicemail/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ listened }),
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "VOICEMAIL_UPDATE_FAILED");
  return json;
}

export async function getTeamDirectory(token: string): Promise<TeamDirectoryMember[]> {
  // IMPORTANT — tenant isolation:
  // We intentionally do NOT send `?global=1`. The Connect API
  // (/voice/pbx/resources/extensions) hard-scopes this response to the JWT's
  // tenantId for every non-SUPER_ADMIN role; the `global=1` flag is only
  // honored when the authenticated user is a SUPER_ADMIN. Omitting it makes
  // the mobile client's intent explicit: ask for the caller's tenant.
  const res = await fetch(`${API_BASE}/voice/pbx/resources/extensions`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "TEAM_DIRECTORY_FAILED");
  const rows = Array.isArray(json?.rows) ? json.rows : [];
  return rows
    .map((row: any): TeamDirectoryMember | null => {
      const extension = String(row.extension ?? row.extNumber ?? row.ext_number ?? row.number ?? row.sipExtension ?? "").trim();
      if (!/^\d{2,6}$/.test(extension)) return null;
      const name = String(row.displayName ?? row.display_name ?? row.name ?? row.callerid ?? row.callerId ?? `Extension ${extension}`).trim();
      const lower = name.toLowerCase();
      if (
        lower === "pbx user" ||
        /^pbx user\s+\d+$/.test(lower) ||
        lower.includes("invite lifecycle") ||
        lower.includes("provisioning") ||
        lower.includes("smoke") ||
        lower.includes("system") ||
        lower === "voice user" ||
        /^voice user\s+\d+$/.test(lower)
      ) {
        return null;
      }
      return {
        id: String(row.connectExtensionId ?? row.id ?? extension),
        name,
        extension,
        email: row.email ?? row.assignedUser ?? row.pbxUserEmail ?? null,
        department: row.department ?? row.team ?? null,
        title: row.title ?? row.role ?? null,
        tenantId: row.tenantId ?? row.tenant_id ?? null,
        tenantName: row.tenantName ?? row.tenant_name ?? null,
        presence: "offline",
      };
    })
    .filter(Boolean)
    .sort((a: TeamDirectoryMember, b: TeamDirectoryMember) =>
      a.extension.localeCompare(b.extension, undefined, { numeric: true }),
    ) as TeamDirectoryMember[];
}

export async function getContacts(token: string, query = ""): Promise<ContactsResponse> {
  const params = new URLSearchParams();
  if (query.trim()) params.set("q", query.trim());
  const qs = params.toString();
  const res = await fetch(`${API_BASE}/contacts${qs ? `?${qs}` : ""}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "CONTACTS_FAILED");
  return json as ContactsResponse;
}

export async function getChatThreads(token: string): Promise<ChatThread[]> {
  const res = await fetch(`${API_BASE}/chat/threads`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "CHAT_THREADS_FAILED");
  return Array.isArray(json?.threads) ? (json.threads as ChatThread[]) : [];
}

export async function getMessages(token: string, threadId: string): Promise<ChatMessage[]> {
  const res = await fetch(`${API_BASE}/chat/threads/${encodeURIComponent(threadId)}/messages`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "CHAT_MESSAGES_FAILED");
  return Array.isArray(json?.messages) ? (json.messages as ChatMessage[]) : [];
}

export async function getChatDirectory(token: string): Promise<ChatDirectoryUser[]> {
  const res = await fetch(`${API_BASE}/chat/directory`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "CHAT_DIRECTORY_FAILED");
  return Array.isArray(json?.users) ? (json.users as ChatDirectoryUser[]) : [];
}

export async function createChatThread(
  token: string,
  input: { type: "dm" | "sms" | "group"; peerUserId?: string; externalPhone?: string; title?: string; peerUserIds?: string[] },
): Promise<{ threadId: string }> {
  const res = await fetch(`${API_BASE}/chat/threads`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "CHAT_THREAD_CREATE_FAILED");
  return json as { threadId: string };
}

export async function sendChatMessage(token: string, threadId: string, body: string): Promise<{ ok: boolean; messageId?: string }> {
  const res = await fetch(`${API_BASE}/chat/threads/${encodeURIComponent(threadId)}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ body }),
  });
  const json = await parseJson(res);
  if (!res.ok) throw new Error(json?.error || "CHAT_SEND_FAILED");
  return json;
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

