// ============================================================================
// iOS-ONLY foreground-active heartbeat.
//
// Purpose: while the Connect app is OPEN (foreground) on an iPhone, tell the
// server "this device is active" every ~15s. The server (POST
// /mobile/foreground-active -> Redis ios_fg_active:<deviceId>, 30s TTL) then
// SKIPS the APNs VoIP push for this device on an incoming call. That is what
// keeps the native CallKit screen — and its native ring, and the CallKit
// audio-session conflict that kills in-app audio — from appearing on top of the
// in-app Connect incoming screen while the app is open.
//
// When the app backgrounds/quits, pings stop and the server key expires within
// 30s, so VoIP pushes (and the native CallKit screen) resume automatically for
// the app-closed case.
//
// ANDROID: hard no-op. `Platform.OS !== 'ios'` returns an empty cleanup before
// anything runs, so Android's call/push flow is completely untouched. This file
// is deliberately separate from any shared code.
// ============================================================================
import { AppState, type AppStateStatus, Platform } from "react-native";
import { API_BASE } from "../api/client";

const PING_INTERVAL_MS = 4_000; // re-ping well within the server's short TTL (~10s)

type Opts = {
  /** Current auth JWT, or null/undefined if not signed in yet. */
  getToken: () => string | null | undefined;
  /** Current registered mobileDevice id, or null/undefined if not registered. */
  getDeviceId: () => string | null | undefined;
};

async function postActive(token: string, deviceId: string, active: boolean): Promise<void> {
  try {
    await fetch(`${API_BASE}/mobile/foreground-active`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ deviceId, active }),
    });
  } catch {
    // Best-effort. A failed ping only means a VoIP push might fire (fail-open on
    // the server too), so the call still rings — it never breaks the app.
  }
}

/**
 * Start the heartbeat. Returns a cleanup function. No-op on Android.
 */
export function startIosForegroundActiveHeartbeat(opts: Opts): () => void {
  if (Platform.OS !== "ios") return () => {};

  let interval: ReturnType<typeof setInterval> | null = null;

  const ping = (active: boolean) => {
    const token = opts.getToken();
    const deviceId = opts.getDeviceId();
    if (!token || !deviceId) {
      console.log(`[FG_HEARTBEAT] skip ping active=${active} (token=${!!token} deviceId=${!!deviceId})`);
      return;
    }
    console.log(`[FG_HEARTBEAT] ping active=${active} deviceId=${deviceId}`);
    void postActive(token, deviceId, active);
  };

  const startPinging = () => {
    ping(true); // immediate — covers a call that arrives right after foregrounding
    if (interval) clearInterval(interval);
    interval = setInterval(() => ping(true), PING_INTERVAL_MS);
  };

  const stopPinging = (clearOnServer: boolean) => {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    if (clearOnServer) ping(false); // tell the server we're backgrounded -> pushes resume
  };

  const onChange = (state: AppStateStatus) => {
    if (state === "active") startPinging();
    else stopPinging(true);
  };

  const sub = AppState.addEventListener("change", onChange);
  if (AppState.currentState === "active") startPinging();

  return () => {
    sub.remove();
    stopPinging(false);
  };
}
