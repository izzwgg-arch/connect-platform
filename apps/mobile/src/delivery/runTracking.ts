// Run-tracking orchestration: ties the SERVER tracking session
// (POST /mobile/delivery/tracking/start|end — the bound inside which location
// is collected) to the DEVICE foreground-location task (trackingService.ts).
// This is the wiring the 2026-08-25 status investigation found missing: the
// server and the location task both existed and nothing ever connected them.
//
// Failure directions, deliberately asymmetric:
//  * Location permission refused → the server session is ended immediately
//    ("PERMISSION_DENIED") so the dispatcher never sees a driver as ON_RUN
//    with a map that will stay empty forever.
//  * endRunTracking always stops the DEVICE task even when the server call
//    fails — a phone that keeps reporting location after "End run" is the
//    worse failure; the server sweeps stale sessions on its side.
import AsyncStorage from "@react-native-async-storage/async-storage";

import { startTrackingSession, endTrackingSession } from "./deliveryClient";
import { startTracking, stopTracking } from "./trackingService";

const SESSION_KEY = "cc_delivery_run_session";

export interface ActiveRunSession {
  sessionId: string;
  runId: string;
  startedAt: number;
}

export async function activeRunSession(): Promise<ActiveRunSession | null> {
  try {
    const raw = await AsyncStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.sessionId !== "string" || typeof parsed?.runId !== "string") return null;
    return parsed as ActiveRunSession;
  } catch {
    return null;
  }
}

export type StartRunResult = { ok: true } | { ok: false; code: "location_permission" | "server" };

export async function startRunTracking(token: string, runId: string): Promise<StartRunResult> {
  let sessionId: string;
  try {
    ({ sessionId } = await startTrackingSession(token, runId));
  } catch {
    return { ok: false, code: "server" };
  }
  const started = await startTracking(token, sessionId).catch(() => false);
  if (!started) {
    await endTrackingSession(token, sessionId, "PERMISSION_DENIED").catch(() => {});
    return { ok: false, code: "location_permission" };
  }
  await AsyncStorage.setItem(SESSION_KEY, JSON.stringify({ sessionId, runId, startedAt: Date.now() } satisfies ActiveRunSession)).catch(() => {});
  return { ok: true };
}

export async function endRunTracking(token: string, reason = "COMPLETED"): Promise<void> {
  const session = await activeRunSession();
  // Device first — see the header. Never leave the location task running.
  await stopTracking().catch(() => {});
  if (session) {
    await endTrackingSession(token, session.sessionId, reason).catch(() => {});
  }
  await AsyncStorage.removeItem(SESSION_KEY).catch(() => {});
}
