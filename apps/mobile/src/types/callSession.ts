// Multi-call state model. Mirrors the plan's §2 state model verbatim so the
// manager, UI components, and backend/hydration path all agree on field names.

export type CallSessionState =
  | "ringing_inbound"
  | "dialing_outbound"
  | "connecting"
  | "active"
  | "held"
  | "ending"
  | "ended";

export type CallDirection = "inbound" | "outbound";

export type CallSession = {
  /** App-level id. For inbound calls this equals `CallInvite.id` when known,
   *  otherwise falls back to the JsSIP session id. For outbound we mint one. */
  id: string;
  /** JsSIP session id — correlates back to SIP primitives (hold/unhold/hangup). */
  sipSessionId: string | null;
  direction: CallDirection;
  remoteNumber: string;
  remoteName: string | null;
  state: CallSessionState;
  startedAt: number;
  answeredAt: number | null;
  heldAt: number | null;
  endedAt: number | null;
  /** Telephony correlation id (PBX linkedId). Needed for backend hold/resume. */
  pbxCallId: string | null;
  /** CallKit/ConnectionService UUID on mobile. Null on web. */
  nativeUuid: string | null;
  canHold: boolean;
  canResume: boolean;
  canSwap: boolean;
};

export type MultiCallState = {
  /** The single "foreground" call with live audio, or null if none. */
  activeCallId: string | null;
  /** LIFO stack — index 0 is the most-recently-held call (auto-resumes first). */
  heldCallIds: string[];
  /** Inbound calls currently alerting (ringing_inbound) that the user hasn't answered. */
  ringingCallIds: string[];
  /** Canonical session map; every id in the arrays above MUST be a key here. */
  callsById: Record<string, CallSession>;
};

export const INITIAL_MULTI_CALL_STATE: MultiCallState = {
  activeCallId: null,
  heldCallIds: [],
  ringingCallIds: [],
  callsById: {},
};

/**
 * Maximum concurrent calls per user, enforced in two places:
 *   1. Client SIP UA rejects the 6th INVITE with 486 Busy Here.
 *   2. CallSessionManager rejects outbound attempts at the limit.
 * Matches legacy desk-phone norms (Cisco 7970, Polycom VVX).
 */
export const MAX_CONCURRENT_CALLS = 5;
