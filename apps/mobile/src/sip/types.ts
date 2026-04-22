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
  /** Fires when an incoming call arrives. `callerNumber` is the remote party. */
  onIncomingCall?: (callerNumber: string) => void;
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

export type SipClient = {
  configure: (bundle: ProvisioningBundle) => void;
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
  ) => Promise<boolean>;
  rejectIncoming: (match?: SipMatch) => Promise<boolean>;
  hangup: () => Promise<void>;
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
};
