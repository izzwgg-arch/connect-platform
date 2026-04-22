/**
 * Temporary live-call timeline for USB debugging (logcat + on-device overlay).
 * Every line is JSON with a `stage` field — grep logcat for `CALL_FLOW` or filter tag `ConnectCallFlow` (native).
 */
import { AppState, type AppStateStatus } from "react-native";

export const CALL_FLOW_CONSOLE_PREFIX = "[CALL_FLOW]";

type CallFlowListener = () => void;

const listeners = new Set<CallFlowListener>();
const ringBuffer: string[] = [];
const RING_MAX = 80;

let lastAppState: AppStateStatus = AppState.currentState;
let lastError: string | null = null;
let lastInviteId: string | null = null;

let appStateSubscribed = false;

/** Idempotent — call once from App mount (avoids duplicate listeners on Fast Refresh). */
export function ensureCallFlowAppStateHook(): void {
  if (appStateSubscribed) return;
  appStateSubscribed = true;
  AppState.addEventListener("change", (s) => {
    lastAppState = s;
    listeners.forEach((l) => l());
  });
}

/** Maps existing [ANSWER_FLOW] events to cross-stack timeline stages. */
const ANSWER_FLOW_TO_TIMELINE: Record<string, string> = {
  INCOMING_PUSH_RECEIVED: "PUSH_RECEIVED_FOREGROUND",
  CALLKEEP_UI_SHOWN: "CALLKEEP_DISPLAY_DONE",
  CALLKEEP_ANSWER_TAPPED: "ANSWER_TAPPED",
  SIP_ANSWER_REQUESTED: "SIP_ANSWER_START",
  SIP_ANSWER_SENT: "SIP_ANSWER_SENT",
  SIP_ANSWER_CONFIRMED: "SIP_CONNECTED",
  SIP_ANSWER_FAILED: "SIP_ANSWER_FAILED",
  UI_SWITCHED_TO_CONNECTING: "UI_SWITCHED_TO_CONNECTING",
  UI_SWITCHED_TO_ACTIVE: "UI_SWITCHED_TO_ACTIVE",
  RINGTONE_STOPPED: "RINGTONE_STOP_JS_CONTEXT",
  INCOMING_UI_DISMISSED: "INCOMING_UI_DISMISSED",
  CALL_ENDED_UI_SHOWN: "CALL_ENDED_SCREEN_SHOWN",
  RETURNED_TO_QUICK_ACTION: "NAVIGATE_BACK_TO_QUICK",
  APP_FOREGROUNDED_FROM_CALL: "APP_FOREGROUNDED_FROM_CALL",
  INVITE_RESTORED: "INVITE_RESTORED",
  INVITE_RESTORE_FAILED: "INVITE_RESTORE_FAILED",
  PBX_CALL_ANSWERED: "PBX_CALL_ANSWERED",
  PBX_STILL_RINGING_AFTER_ANSWER: "PBX_STILL_RINGING_AFTER_ANSWER",
  ANSWER_DESYNC_DETECTED: "ANSWER_DESYNC_DETECTED",
};

export type CallFlowSnapshot = {
  appState: AppStateStatus;
  lastInviteId: string | null;
  lastError: string | null;
  recentLines: string[];
};

export function subscribeCallFlowDebug(listener: CallFlowListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getCallFlowSnapshot(): CallFlowSnapshot {
  return {
    appState: lastAppState,
    lastInviteId,
    lastError,
    recentLines: ringBuffer.slice(),
  };
}

export function setCallFlowLastError(message: string | null): void {
  lastError = message;
  listeners.forEach((l) => l());
}

export function setCallFlowInviteId(id: string | null): void {
  lastInviteId = id;
  listeners.forEach((l) => l());
}

export function logCallFlow(
  stage: string,
  opts?: {
    inviteId?: string | null;
    pbxCallId?: string | null;
    extension?: string | null;
    extra?: Record<string, unknown>;
  },
): void {
  const ts = new Date().toISOString();
  const appState = AppState.currentState;
  const inviteId = opts?.inviteId ?? null;
  if (inviteId) lastInviteId = inviteId;

  const payload: Record<string, unknown> = {
    tag: "CALL_FLOW",
    stage,
    ts,
    appState,
    inviteId,
    pbxCallId: opts?.pbxCallId ?? null,
    extension: opts?.extension ?? null,
    ...(opts?.extra && typeof opts.extra === "object" ? opts.extra : {}),
  };

  const line = `${CALL_FLOW_CONSOLE_PREFIX} ${JSON.stringify(payload)}`;
  console.log(line);

  ringBuffer.push(`${stage} ${ts}${inviteId ? ` invite=${inviteId}` : ""}`);
  if (ringBuffer.length > RING_MAX) ringBuffer.splice(0, ringBuffer.length - RING_MAX);
  listeners.forEach((l) => l());
}

/** Bridge NotificationsContext answer-flow telemetry into CALL_FLOW lines. */
export function logCallFlowFromAnswerFlow(
  answerFlowType: string,
  invite: { id?: string | null; pbxCallId?: string | null; toExtension?: string | null } | null,
  extra?: Record<string, unknown>,
): void {
  const mapped = ANSWER_FLOW_TO_TIMELINE[answerFlowType] ?? answerFlowType;
  logCallFlow(mapped, {
    inviteId: invite?.id ?? null,
    pbxCallId: invite?.pbxCallId ?? null,
    extension: invite?.toExtension ?? null,
    extra: { answerFlowType, ...extra },
  });
}

export async function logCallFlowBootDiagnostics(readPendingJson: () => Promise<string | null>): Promise<void> {
  logCallFlow("JS_APP_MOUNT", {});
  try {
    const raw = await readPendingJson();
    if (raw) {
      let inviteId: string | null = null;
      try {
        const p = JSON.parse(raw) as { inviteId?: string };
        inviteId = p.inviteId ? String(p.inviteId) : null;
      } catch {
        /* ignore */
      }
      logCallFlow("APP_RESTART_PENDING_INVITE_IN_STORAGE", {
        inviteId,
        extra: { bytes: raw.length },
      });
    }
  } catch {
    /* ignore */
  }
}
