import type { CallState, ProvisioningBundle, SipRegistrationState } from "../types";

/**
 * Per-session state reported by the multi-call bridge. Mirrors the subset of
 * `CallState` that makes sense at the individual SIP session level.
 */
export type SipSessionState =
  | "ringing"      // remote INVITE received, awaiting answer
  | "dialing"      // outbound, awaiting 200 OK
  | "connecting"   // 200 OK sent/received, waiting for final confirmation
  | "connected"    // media flowing
  | "held"         // re-INVITE sendonly ack'd
  | "ended";       // terminal

/**
 * Snapshot of a JsSIP session, emitted to higher layers via
 * `onSessionAdded` / `onSessionStateChanged`. Identifies the session by
 * its JsSIP-assigned id so the manager can correlate events back to
 * the `CallSession` it owns.
 */
export type SipSessionInfo = {
  sessionId: string;
  direction: "inbound" | "outbound";
  /**
   * When the call was confirmed (SIP ACK), epoch ms — null while ringing.
   * Lets a remounted UI tree backdate the call timer during hydration
   * instead of restarting it at 0:00.
   */
  confirmedAtMs?: number | null;
  callerNumber: string;
  callerDisplayName: string | null;
  state: SipSessionState;
  isHeld: boolean;
};

export type SipEvents = {
  onRegistrationState?: (state: SipRegistrationState) => void;
  /**
   * Stage 1 keep-alive hook — fires when the JsSIP transport emits
   * `connected` / `disconnected`. Higher layers use this to drive the
   * reconnect orchestrator. `reason` on disconnect is the JsSIP cause
   * string if known, otherwise "unknown".
   */
  onSocketConnected?: () => void;
  onSocketDisconnected?: (reason: string) => void;
  /**
   * Fires when an incoming call arrives.
   * `callerNumber` is the SIP URI user (actual phone number or extension).
   * `callerName` is the SIP display name, which for ring group calls contains
   * the ring group prefix (e.g. "New Tires:Caller Name"). Null when absent.
   */
  onIncomingCall?: (callerNumber: string, callerName?: string | null) => void;
  /**
   * Single-call "active pointer" state — kept intact for legacy screens.
   * Multi-call consumers should subscribe to `onSessionStateChanged` and
   * `onSessionAdded`/`onSessionRemoved` instead.
   */
  onCallState?: (state: CallState) => void;
  onError?: (message: string) => void;

  /** Fires once per newly-observed JsSIP session. */
  onSessionAdded?: (info: SipSessionInfo) => void;
  /** Fires on any per-session state transition. */
  onSessionStateChanged?: (info: SipSessionInfo) => void;
  /** Fires when a session has been fully terminated and removed. */
  onSessionRemoved?: (sessionId: string) => void;
  /** Structured outbound dial milestones for Call Flight Recorder. */
  onOutboundTrace?: (event: OutboundTraceEvent) => void;
  /** Fires when JsSIP receives a remote INVITE (newRTCSession). */
  onIncomingInviteReceived?: (info: {
    sessionId: string;
    from: string;
    to: string | null;
    callerName: string | null;
  }) => void;
};

export type OutboundTraceEvent = {
  stage:
    | "OUTBOUND_INVITE_SENT"
    | "OUTBOUND_RINGING"
    | "OUTBOUND_CONNECTED"
    | "OUTBOUND_FAILED"
    | "OUTBOUND_ENDED";
  timestamp: number;
  dialedNumber?: string | null;
  normalizedNumber?: string | null;
  sipCode?: number | null;
  sipReason?: string | null;
  sipCause?: string | null;
  failedOriginator?: string | null;
  registrationAgeMs?: number | null;
};

export type SipMatch = {
  inviteId?: string | null;
  fromNumber?: string | null;
  toExtension?: string | null;
  pbxCallId?: string | null;
  sipCallTarget?: string | null;
};

export type SipAnswerTraceEvent = {
  phase: "sent" | "confirmed" | "failed";
  timestamp: number;
  code?: number | null;
  reason?: string | null;
  message?: string | null;
};

export type { SipAnswerDeadlineHandle } from "./mobileAnswerTiming";

export type SipClient = {
  configure: (bundle: ProvisioningBundle) => void;
  setBlackboxContext?: (ctx: Record<string, unknown>) => void;
  beginInboundBlackbox?: (inviteId: string | null | undefined, meta?: Record<string, unknown>) => void;
  finalizeInboundBlackboxFailure?: (input: {
    inviteId?: string | null;
    pbxCallId?: string | null;
    callerNumber?: string | null;
    calleeExtension?: string | null;
    failureReason: string;
    backendAccept?: Record<string, unknown> | null;
    uiState?: Record<string, unknown> | null;
    pushMeta?: Record<string, unknown> | null;
    forceRestart?: { decided?: boolean; reason?: string | null };
  }) => void;
  register: (options?: { forceRestart?: boolean }) => Promise<void>;
  unregister: () => Promise<void>;
  /**
   * Stage 1 health probes — synchronous, side-effect-free reads of the
   * underlying JsSIP UA state. Used by the keep-alive / reconnect
   * orchestrator in SipContext to detect stale sockets and decide
   * whether a reconnect is needed.
   */
  isConnected: () => boolean;
  isRegistered: () => boolean;
  /** Milliseconds since last successful SIP REGISTER, or null if unknown. */
  getRegistrationAgeMs: () => number | null;
  /**
   * True iff the UA currently owns at least one live SIP session
   * (ringing, dialing, connected, held). Reconnect must NOT force
   * a UA restart while this is true — it would kill the live call.
   */
  hasActiveSession: () => boolean;
  dial: (target: string) => Promise<void>;
  answer: () => Promise<void>;
  answerIncoming: (
    match?: SipMatch,
    timeoutMs?: number,
    onTrace?: (event: SipAnswerTraceEvent) => void,
    deadlineHandle?: import("./mobileAnswerTiming").SipAnswerDeadlineHandle,
  ) => Promise<boolean>;
  /** Poll until a matching incoming session exists or the deadline expires. */
  waitForIncomingInvite: (
    match?: SipMatch,
    deadlineHandle?: import("./mobileAnswerTiming").SipAnswerDeadlineHandle,
  ) => Promise<boolean>;
  /** Synchronous probe: is a matching inbound INVITE already live on the UA? */
  hasMatchingIncomingInvite: (match?: SipMatch) => boolean;
  rejectIncoming: (match?: SipMatch) => Promise<boolean>;
  hangup: () => Promise<void>;
  /**
   * Android-only inbound-answer latency optimization (Phase 1 / Option 2A).
   * Pre-acquire the mic MediaStream during the incoming ring so JsSIP's
   * `answer()` can skip its internal getUserMedia (the bulk of the
   * 200-OK → ICE-gathering delay). Best-effort: any failure is swallowed and
   * the normal answer path (internal getUserMedia) still works. No-op off
   * Android. Idempotent while a stream is already warmed/in-flight.
   */
  prewarmInboundMedia: () => void;
  /** Release any prewarmed inbound mic stream. Idempotent; safe to call any time. */
  releasePrewarmedMedia: (reason: string) => void;
  setMute: (mute: boolean) => void;
  setSpeaker: (speakerOn: boolean) => void;
  hold: () => void;
  unhold: () => void;
  sendDtmf: (digit: string) => void;
  setEvents: (events: SipEvents) => void;

  // === Multi-call per-session API ============================================
  /** All sessions currently tracked (ringing, dialing, connected, held). */
  listSessions: () => SipSessionInfo[];
  /** Put a specific session on hold (client-side re-INVITE sendonly). */
  holdSession: (sessionId: string) => boolean;
  /** Resume a specific held session (client-side re-INVITE sendrecv). */
  unholdSession: (sessionId: string) => boolean;
  /** Hangup a specific session without disturbing siblings. */
  hangupSession: (sessionId: string) => boolean;
  /**
   * Answer a specific incoming session by its id. Waits briefly for the
   * session to become answerable and returns true on confirmed.
   */
  answerSession: (
    sessionId: string,
    timeoutMs?: number,
    onTrace?: (event: SipAnswerTraceEvent) => void,
  ) => Promise<boolean>;
  /** Returns the current state of a session, or null if unknown. */
  getSessionState: (sessionId: string) => SipSessionState | null;
  /** Switch the "active pointer" so legacy methods (hold/hangup/setMute) target this session. */
  setActiveSession: (sessionId: string) => boolean;
  /** True iff a session with this id currently exists and is not ended. */
  isSessionAlive: (sessionId: string) => boolean;
  /** Blind-transfer a specific session to the given target (SIP REFER). */
  transferSession: (sessionId: string, target: string) => boolean;
};
