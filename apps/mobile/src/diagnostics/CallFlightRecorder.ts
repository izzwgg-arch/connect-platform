/**
 * CallFlightRecorder — mobile black-box diagnostics for every call.
 *
 * Records a full structured timeline for every call attempt and uploads it
 * to the API.  The upload is deferred (batched) so it never blocks the call path.
 *
 * Usage:
 *   flight.beginCall({ inviteId, pbxCallId, tenantId, userId, ... })
 *   flight.record('SIP', 'SIP_REGISTERED', { ... })
 *   flight.endCall('answered')
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, AppStateStatus } from 'react-native';

// NetInfo is optional — gracefully degraded if not installed
let getNetworkType: () => Promise<string> = async () => 'unknown';
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const NI = require('@react-native-community/netinfo').default;
  getNetworkType = async () => {
    try {
      const s = await NI.fetch();
      return s?.type ?? 'unknown';
    } catch {
      return 'unknown';
    }
  };
} catch {
  // NetInfo not available — proceed without it
}

// ─── Event schema ─────────────────────────────────────────────────────────────

export type FlightCategory =
  | 'PUSH'
  | 'APP'
  | 'UI'
  | 'USER'
  | 'AUDIO'
  | 'SIP'
  | 'NATIVE'
  | 'NETWORK'
  | 'BACKEND'
  | 'SYSTEM';

export interface FlightEvent {
  /** Monotonic counter within this session */
  seq: number;
  /** ISO 8601 with milliseconds */
  ts: string;
  /** Epoch ms for arithmetic */
  tsMs: number;
  category: FlightCategory;
  /** Fine-grained event name e.g. SIP_REGISTERED, RINGTONE_START */
  stage: string;
  /** App foreground/background/inactive at event time */
  appState: AppStateStatus;
  /** Current screen / route */
  screen?: string | null;
  /** SIP registration / call state at event time */
  sipState?: string | null;
  /** Audio route at event time */
  audioState?: string | null;
  /** info | warn | error */
  severity: 'info' | 'warn' | 'error';
  /** Correlation IDs if available at event time */
  inviteId?: string | null;
  pbxCallId?: string | null;
  /** Free-form payload — keep lean */
  payload?: Record<string, unknown>;
}

// ─── Session metadata ──────────────────────────────────────────────────────────

export interface FlightSessionMeta {
  inviteId?: string | null;
  pbxCallId?: string | null;
  linkedId?: string | null;
  tenantId?: string | null;
  userId?: string | null;
  deviceId?: string | null;
  extension?: string | null;
  fromNumber?: string | null;
  platform: string;
  appVersion?: string | null;
  networkType?: string | null;
}

export interface FlightSession {
  id: string;
  meta: FlightSessionMeta;
  startedAt: string;
  startedAtMs: number;
  endedAt?: string;
  endedAtMs?: number;
  result?: string;
  uiMode?: string;
  events: FlightEvent[];
}

// ─── Warning flag detection ────────────────────────────────────────────────────

interface TimingStats {
  answerDelayMs?: number;
  sipConnectMs?: number;
  pushToUiMs?: number;
  hadRingtone: boolean;
  hadBlankScreen: boolean;
  hadAppRestart: boolean;
  hadFullScreen: boolean;
  warningFlags: string[];
}

function computeStats(session: FlightSession): TimingStats {
  const evs = session.events;
  const stats: TimingStats = {
    hadRingtone: false,
    hadBlankScreen: false,
    hadAppRestart: false,
    hadFullScreen: false,
    warningFlags: [],
  };

  const byStage = (stage: string) => evs.find(e => e.stage === stage);
  const byStageAll = (stage: string) => evs.filter(e => e.stage === stage);

  const pushReceived = byStage('PUSH_RECEIVED_BG') ?? byStage('PUSH_RECEIVED_FG');
  const uiShown = byStage('INCOMING_SCREEN_SHOWN') ?? byStage('FULL_SCREEN_INCOMING_SHOWN') ?? byStage('FLOATING_BANNER_SHOWN');
  const ringtoneStart = byStage('RINGTONE_START');
  const answerTapped = byStage('ANSWER_TAPPED');
  const sipConnected = byStage('SIP_CONNECTED') ?? byStage('CALL_CONNECTED');
  const blankScreen = byStage('BLANK_SCREEN_DETECTED');
  const appRestart = byStage('APP_REMOUNT_DETECTED') ?? byStage('SPLASH_SHOWN_AFTER_CALL');
  const fullScreen = byStage('FULL_SCREEN_INCOMING_SHOWN');

  stats.hadRingtone = !!ringtoneStart;
  stats.hadBlankScreen = !!blankScreen;
  stats.hadAppRestart = !!appRestart;
  stats.hadFullScreen = !!fullScreen;

  if (pushReceived && uiShown) {
    stats.pushToUiMs = uiShown.tsMs - pushReceived.tsMs;
  }
  if (answerTapped && sipConnected) {
    stats.answerDelayMs = sipConnected.tsMs - answerTapped.tsMs;
  }
  if (answerTapped && byStage('SIP_ANSWER_START')) {
    // sipConnectMs: from when SIP answer was initiated to SIP connected
    const sipStart = byStage('SIP_ANSWER_START')!;
    if (sipConnected) {
      stats.sipConnectMs = sipConnected.tsMs - sipStart.tsMs;
    }
  }

  // ── Automatic warning flags ────────────────────────────────────────────────
  if (!stats.hadRingtone && session.result !== 'declined' && session.result !== 'missed_no_push') {
    stats.warningFlags.push('RINGTONE_MISSING');
  }

  if (ringtoneStart && pushReceived && ringtoneStart.tsMs - pushReceived.tsMs > 4000) {
    stats.warningFlags.push('RINGTONE_LATE_START');
  }

  if (stats.pushToUiMs != null && stats.pushToUiMs > 5000) {
    stats.warningFlags.push('PUSH_TO_UI_DELAY');
  }

  if (!uiShown && pushReceived) {
    stats.warningFlags.push('UI_NEVER_SHOWN');
  }

  if (stats.answerDelayMs != null && stats.answerDelayMs > 3000) {
    stats.warningFlags.push('ANSWER_DELAY_HIGH');
  }

  if (stats.sipConnectMs != null && stats.sipConnectMs > 5000) {
    stats.warningFlags.push('SIP_CONNECT_SLOW');
  }

  if (stats.hadBlankScreen) {
    stats.warningFlags.push('BLANK_SCREEN_DETECTED');
  }

  if (stats.hadAppRestart) {
    stats.warningFlags.push('APP_RESTART_AFTER_CALL');
  }

  if (
    uiShown &&
    uiShown.stage === 'FLOATING_BANNER_SHOWN' &&
    evs.some(e => e.stage === 'APP_STATE_HOME_SCREEN')
  ) {
    stats.warningFlags.push('FLOATING_ON_HOME_SCREEN');
  }

  const callEndedShown = byStage('CALL_ENDED_SCREEN_SHOWN');
  const callEndedNav = byStage('NAVIGATE_BACK_TO_HOME');
  if (callEndedShown && callEndedNav) {
    const stuckMs = callEndedNav.tsMs - callEndedShown.tsMs;
    if (stuckMs > 8000) stats.warningFlags.push('CALL_ENDED_STUCK');
  }

  const waitingForPbx = byStageAll('WAITING_FOR_PBX_SHOWN');
  if (waitingForPbx.length > 0) {
    const sipAnswerStart = byStage('SIP_ANSWER_START');
    if (sipAnswerStart) {
      const delay = sipAnswerStart.tsMs - waitingForPbx[0].tsMs;
      if (delay > 4000) stats.warningFlags.push('WAITING_FOR_PBX_TOO_LONG');
    }
  }

  return stats;
}

// ─── Uploader ─────────────────────────────────────────────────────────────────

const UPLOAD_QUEUE_KEY = 'connect_flight_recorder_queue';
const MAX_QUEUE_SIZE = 20;
const MAX_EVENTS_PER_SESSION = 200;

interface QueueEntry {
  session: FlightSession;
  stats: TimingStats;
  retries: number;
}

async function loadQueue(): Promise<QueueEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(UPLOAD_QUEUE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as QueueEntry[];
  } catch {
    return [];
  }
}

async function saveQueue(q: QueueEntry[]): Promise<void> {
  try {
    const trimmed = q.slice(-MAX_QUEUE_SIZE);
    await AsyncStorage.setItem(UPLOAD_QUEUE_KEY, JSON.stringify(trimmed));
  } catch {
    // ignore storage errors
  }
}

let uploadApiUrl: string | null = null;
let uploadAuthToken: string | null = null;

/** Must be called once at app init with the API base URL and auth token. */
export function configureFlightRecorder(opts: {
  apiBaseUrl: string;
  getAuthToken: () => string | null;
}): void {
  uploadApiUrl = opts.apiBaseUrl.replace(/\/$/, '');
  _getToken = opts.getAuthToken;
}

let _getToken: (() => string | null) | null = null;

async function uploadSession(entry: QueueEntry): Promise<boolean> {
  if (!uploadApiUrl) return false;
  const token = _getToken?.();
  if (!token) return false;
  try {
    const body = {
      session: entry.session,
      stats: entry.stats,
    };
    const res = await fetch(`${uploadApiUrl}/mobile/flight-recorder/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function drainQueue(): Promise<void> {
  const q = await loadQueue();
  if (q.length === 0) return;

  const remaining: QueueEntry[] = [];
  for (const entry of q) {
    if (entry.retries >= 5) continue; // discard after 5 failures
    const ok = await uploadSession(entry);
    if (!ok) {
      remaining.push({ ...entry, retries: entry.retries + 1 });
    }
  }
  await saveQueue(remaining);
}

// ─── Recorder singleton ────────────────────────────────────────────────────────

let _seq = 0;
let _active: FlightSession | null = null;
let _screen: string | null = null;
let _sipState: string | null = null;
let _audioState: string | null = null;

function uid(): string {
  return `cfs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Notify the recorder of the current screen so events get screen context.
 * Call this from navigation state change handlers.
 */
export function flightSetScreen(screen: string | null): void {
  _screen = screen;
}

/** Notify the recorder of the current SIP state. */
export function flightSetSipState(state: string | null): void {
  _sipState = state;
}

/** Notify the recorder of the current audio route. */
export function flightSetAudioState(state: string | null): void {
  _audioState = state;
}

/**
 * Begin a new call flight session.
 *
 * Key guarantees:
 * 1. If a session already exists for the SAME inviteId, it is kept and enriched
 *    (e.g. background push session continues into the foreground answer session).
 * 2. `_active` is ALWAYS set synchronously — no awaits before the assignment —
 *    so `flightRecord()` calls immediately after `void flightBeginCall()` are
 *    never silently dropped due to the async race that existed previously.
 * 3. The previous session (if any) is ended and queued asynchronously after the
 *    new `_active` is already in place.
 */
export async function flightBeginCall(meta: Partial<FlightSessionMeta> & { inviteId?: string | null }): Promise<void> {
  // ── Same-invite continuation ────────────────────────────────────────────────
  // If the existing session is for the same invite, just enrich it and return.
  // This preserves PUSH_RECEIVED_BG events already captured in the background.
  if (_active && meta.inviteId && _active.meta.inviteId === meta.inviteId) {
    Object.assign(_active.meta, meta);
    return;
  }

  // ── Synchronously swap out the old session and swap in the new one ──────────
  // Capture the previous session BEFORE setting _active to the new one.
  // This way any flightRecord() calls that fire immediately after this function
  // (via `void flightBeginCall()`) land on the NEW session, not the old one.
  const prevSession = _active;

  _seq = 0;
  _active = {
    id: uid(),
    meta: {
      platform: 'ANDROID',
      ...meta,
      networkType: 'unknown',
    },
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
    events: [],
  };

  // ── Asynchronous clean-up (does NOT block the new session) ─────────────────
  // End + queue the previous session without blocking the caller.
  if (prevSession) {
    prevSession.endedAt = new Date().toISOString();
    prevSession.endedAtMs = Date.now();
    if (!prevSession.result) prevSession.result = 'unknown';
    const stats = computeStats(prevSession);
    loadQueue()
      .then(q => {
        q.push({ session: prevSession, stats, retries: 0 });
        return saveQueue(q);
      })
      .catch(() => {});
  }

  // Fill in real network type without blocking the caller
  getNetworkType().then(networkType => {
    if (_active) _active.meta.networkType = networkType;
  }).catch(() => {});
}

/**
 * Record a single flight event.  Safe to call at any time — no-ops if no active session.
 */
export function flightRecord(
  category: FlightCategory,
  stage: string,
  opts?: {
    severity?: 'info' | 'warn' | 'error';
    inviteId?: string | null;
    pbxCallId?: string | null;
    screen?: string | null;
    sipState?: string | null;
    audioState?: string | null;
    payload?: Record<string, unknown>;
    /** Override timestamp (e.g. from native bridge for pre-JS events) */
    ts?: number;
  },
): void {
  const session = _active;
  if (!session) return;

  // Update correlation IDs on session if we just learned them
  if (opts?.inviteId && !session.meta.inviteId) {
    session.meta.inviteId = opts.inviteId;
  }
  if (opts?.pbxCallId && !session.meta.pbxCallId) {
    session.meta.pbxCallId = opts.pbxCallId;
  }

  const nowMs = opts?.ts ?? Date.now();
  const ev: FlightEvent = {
    seq: _seq++,
    ts: new Date(nowMs).toISOString(),
    tsMs: nowMs,
    category,
    stage,
    appState: AppState.currentState,
    screen: opts?.screen ?? _screen,
    sipState: opts?.sipState ?? _sipState,
    audioState: opts?.audioState ?? _audioState,
    severity: opts?.severity ?? 'info',
    inviteId: opts?.inviteId ?? session.meta.inviteId ?? null,
    pbxCallId: opts?.pbxCallId ?? session.meta.pbxCallId ?? null,
    payload: opts?.payload,
  };

  session.events.push(ev);
  // Prevent unbounded growth within a single call
  if (session.events.length > MAX_EVENTS_PER_SESSION) {
    session.events.splice(0, session.events.length - MAX_EVENTS_PER_SESSION);
  }
}

/**
 * End the current flight session, compute stats/flags, and queue for upload.
 */
export async function flightEndCall(
  result: 'answered' | 'missed' | 'declined' | 'failed' | 'ended' | 'unknown',
  opts?: {
    uiMode?: 'full_screen' | 'floating' | 'in_app';
  },
): Promise<void> {
  const session = _active;
  if (!session) return;

  session.endedAt = new Date().toISOString();
  session.endedAtMs = Date.now();
  session.result = result;
  if (opts?.uiMode) session.uiMode = opts.uiMode;

  _active = null;

  const stats = computeStats(session);

  const q = await loadQueue();
  q.push({ session, stats, retries: 0 });
  await saveQueue(q);

  // Best-effort immediate upload; failures get retried later
  drainQueue().catch(() => {});
}

/**
 * Attempt to drain the upload queue.
 * Called on app foreground and when a network connection is detected.
 */
export function flightDrainQueue(): void {
  drainQueue().catch(() => {});
}

/** Returns the currently active session id (if any). */
export function flightActiveSessionId(): string | null {
  return _active?.id ?? null;
}

/** Returns a snapshot of the current session events for the debug overlay. */
export function flightGetSnapshot(): FlightEvent[] {
  return _active?.events.slice(-30) ?? [];
}
