/**
 * Multi-call session manager — central authority for the per-device call stack.
 *
 * Ownership:
 *   - Maintains `MultiCallState` (active + held stack + ringing + callsById).
 *   - Translates raw SIP per-session events (via SipContext.registerMultiCallListener)
 *     into deterministic CallSession transitions.
 *   - Exposes high-level actions: answerWaiting, declineWaiting, holdActive,
 *     resume, swap, hangup, dialOutbound.
 *   - Implements the LIFO auto-resume policy (plan §1, §3).
 *
 * Non-goals:
 *   - Does NOT own incoming ringtone / full-screen UI — that's owned by the
 *     native IncomingCallFirebaseService on Android for the idle case.
 *   - Does NOT own SIP registration or audio routing — that's SipContext.
 *   - Does NOT talk to the PBX directly — hold is a client SIP re-INVITE; the
 *     backend /mobile/call-invites/:id/hold is state-bookkeeping only.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState, NativeModules, Platform } from "react-native";
import { useSip } from "./SipContext";
import { useAuth } from "./AuthContext";
// Static import: `void import("../audio/telephonyAudio").then(...)` was
// throwing `Requiring unknown module "undefined"` from Metro's async-
// generator helper in release Hermes builds, which crashed the JS bridge
// (mqt_native_modules) when the user answered a call from the home
// screen and the call-waiting path ran. Static import avoids the broken
// dynamic-import helper entirely.
import { playCallWaitingBeep } from "../audio/telephonyAudio";
import {
  getActiveAndHeldInvites,
  holdCallInvite,
  resumeCallInvite,
} from "../api/client";
import type {
  CallSession,
  CallSessionState,
  MultiCallState,
} from "../types/callSession";
import {
  INITIAL_MULTI_CALL_STATE,
  MAX_CONCURRENT_CALLS,
} from "../types/callSession";
import type { SipSessionInfo, SipSessionState } from "../sip/types";

// ---------- Logging helpers ----------
function logMulti(tag: string, msg: string, extra?: Record<string, unknown>) {
  const payload = extra ? " " + JSON.stringify(extra) : "";
  console.log(`[${tag}] ${msg}${payload}`);
}

/**
 * Normalise a remote-party number for correlation between the push-layer
 * CallInvite.fromNumber and the SIP session's caller-number. Strips every
 * non-digit so "+1 (555) 123-4567" and "15551234567" compare equal.
 * Returns an empty string for empty/"Unknown" inputs — those must never
 * match anything else.
 */
function normaliseRemote(input: string | null | undefined): string {
  if (!input) return "";
  const s = String(input).trim();
  if (!s || s.toLowerCase() === "unknown") return "";
  return s.replace(/[^\d]/g, "");
}

function sipToSessionState(s: SipSessionState, isHeld: boolean): CallSessionState {
  if (isHeld || s === "held") return "held";
  if (s === "ringing") return "ringing_inbound";
  if (s === "dialing") return "dialing_outbound";
  if (s === "connecting") return "connecting";
  if (s === "connected") return "active";
  if (s === "ended") return "ended";
  return "connecting";
}

// ---------- Context shape ----------
type CallSessionManagerContextValue = {
  state: MultiCallState;

  /** Get a session by id, or null. */
  getSession: (id: string) => CallSession | null;

  /** Convenience projections. */
  activeCall: CallSession | null;
  heldCalls: CallSession[];
  ringingCalls: CallSession[];
  /**
   * True when the app is engaged in ANY live call — including calls that
   * are still in the "connecting" transition between ringing and active.
   * Used to gate the IncomingCallScreen full-screen so a second invite
   * never wipes away the first call's UI.
   */
  hasAnyOngoingCall: boolean;

  // Actions --------------------------------------------------------------
  /**
   * Answer a waiting inbound call. If another call is active, it is put on
   * hold first. The new call becomes the active call on SIP confirm.
   */
  answerWaiting: (callId: string) => Promise<boolean>;
  /** Decline a waiting inbound call without disturbing the active call. */
  declineWaiting: (callId: string) => Promise<boolean>;
  /** Manually put the current active call on hold (no resume implied). */
  holdActive: () => boolean;
  /**
   * Resume a specific held call. If another call is active, it is put on
   * hold first (swap semantics).
   */
  resume: (callId: string) => boolean;
  /** Alias for resume(targetId) — matches the plan's naming. */
  swap: (targetId: string) => boolean;
  /**
   * Hang up a specific call. If it was the active call and held calls exist,
   * the most-recently-held call auto-resumes (LIFO).
   */
  hangup: (callId: string) => Promise<boolean>;
  /**
   * Blind-transfer a specific call to `target`. Sends a SIP REFER to the
   * remote party — when accepted, the PBX bridges the remote to `target`
   * and our session terminates normally.
   */
  transfer: (callId: string, target: string) => boolean;

  /** Register a new outbound dial attempt. If another call is active, it's held. */
  beginOutbound: (args: {
    callId: string;
    sipSessionId: string | null;
    remoteNumber: string;
  }) => void;

  /**
   * Register an inbound invite from the push/notification layer. If no call is
   * active, this becomes a ringing_inbound. If a call is active, it joins the
   * ringingCallIds as a waiting call (call-waiting UI).
   */
  registerInboundInvite: (args: {
    callId: string;
    remoteNumber: string;
    remoteName?: string | null;
    pbxCallId: string | null;
  }) => void;

  /** Correlate an inbound app-level id (CallInvite.id) with the arriving SIP session. */
  attachSipSession: (callId: string, sipSessionId: string) => void;

  /**
   * Drop a pre-registered inbound invite (push-layer) that never materialised
   * into a SIP session — e.g. the caller canceled before the INVITE arrived,
   * or the invite was recovered from AsyncStorage but is already canceled on
   * the server. Removes the CallSession from `callsById` and `ringingCallIds`.
   * No-op if a SIP session was already attached (that path tears down via
   * onSipSessionRemoved instead).
   */
  removeInboundInvite: (callId: string, reason?: string) => void;

  /** Rehydrate stack from server on app resume / SIP reconnect (Phase 4). */
  hydrateOnReconnect: () => Promise<void>;
};

const CallSessionManagerContext = createContext<
  CallSessionManagerContextValue | undefined
>(undefined);

// ---------- Provider ----------
export function CallSessionProvider({ children }: { children: React.ReactNode }) {
  const sip = useSip();
  const { token: authToken } = useAuth();
  const [state, setState] = useState<MultiCallState>(INITIAL_MULTI_CALL_STATE);

  /**
   * The state store is edited exclusively through `mutate()`, which applies
   * the reducer function and also dumps the resulting snapshot to the
   * [MULTICALL_STATE] log. All async action handlers below ultimately go
   * through this so every transition is auditable.
   */
  const stateRef = useRef<MultiCallState>(state);
  const mutate = useCallback(
    (reason: string, fn: (prev: MultiCallState) => MultiCallState) => {
      setState((prev) => {
        const next = fn(prev);
        stateRef.current = next;
        logMulti("MULTICALL_STATE", reason, {
          active: next.activeCallId,
          held: next.heldCallIds,
          ringing: next.ringingCallIds,
          sessions: Object.keys(next.callsById).length,
        });
        return next;
      });
    },
    [],
  );

  /** sipSessionId → appCallId lookup (sip sessions arrive with their own id). */
  const sipToAppIdRef = useRef<Map<string, string>>(new Map());
  /** appCallId → sipSessionId for outbound dials initiated before the SIP session appears. */
  const appToSipIdRef = useRef<Map<string, string>>(new Map());

  // Max lifetime of a `ringing_inbound` CallSession that hasn't transitioned.
  // A push-registered invite that doesn't receive a matching SIP session
  // within this window is treated as a phantom (e.g. the push was
  // delivered but the SIP INVITE never arrived, or the backend returned
  // an old PENDING invite on a pending-list hydrate after a prior test).
  // Previously 55 s — we tightened it to 15 s because anything genuinely
  // ringing arrives on SIP within a second or two, and a longer window
  // let zombie invites ghost the drawer all the way through the next
  // outbound call.
  const STALE_RINGING_MS = 15_000;

  /**
   * Garbage-collect CallSession rows whose underlying SIP session has
   * quietly died without firing 'ended'/'failed'. Also clears old
   * push-registered invites that never materialised into a SIP session.
   *
   * Runs on every new-call event AND on a 10 s interval while the
   * provider is mounted — ringing phantoms accumulate fastest when remote
   * callers repeatedly ring then cancel.
   */
  const sweepStaleCallSessions = useCallback(() => {
    const snap = stateRef.current;
    const now = Date.now();
    const toRemove: string[] = [];
    for (const [id, cs] of Object.entries(snap.callsById)) {
      // 1) SIP session attached but SIP client no longer tracks it → stale.
      if (cs.sipSessionId) {
        if (!sip.isSipSessionAlive(cs.sipSessionId)) {
          toRemove.push(id);
          continue;
        }
      }
      // 2) Ringing-inbound (no SIP attached) older than STALE_RINGING_MS → stale.
      if (
        cs.state === "ringing_inbound" &&
        !cs.sipSessionId &&
        now - cs.startedAt > STALE_RINGING_MS
      ) {
        toRemove.push(id);
        continue;
      }
      // 3) Ringing-inbound WITH a dead SIP session older than STALE_RINGING_MS.
      if (
        cs.state === "ringing_inbound" &&
        cs.sipSessionId &&
        now - cs.startedAt > STALE_RINGING_MS
      ) {
        toRemove.push(id);
      }
    }
    if (toRemove.length === 0) return;
    logMulti("MULTICALL", "sweep_stale_call_sessions", { removed: toRemove });
    mutate("sweepStale:" + toRemove.length, (prev) => {
      const callsById = { ...prev.callsById };
      for (const id of toRemove) delete callsById[id];
      return {
        activeCallId: toRemove.includes(prev.activeCallId ?? "")
          ? null
          : prev.activeCallId,
        heldCallIds: prev.heldCallIds.filter((x) => !toRemove.includes(x)),
        ringingCallIds: prev.ringingCallIds.filter((x) => !toRemove.includes(x)),
        callsById,
      };
    });
    // Also detach lookup-maps
    for (const id of toRemove) {
      const sipId = appToSipIdRef.current.get(id);
      if (sipId) {
        sipToAppIdRef.current.delete(sipId);
      }
      appToSipIdRef.current.delete(id);
    }
  }, [sip, mutate]);

  useEffect(() => {
    // 3 s tick — frequent enough that a phantom ringing row is gone
    // before the user can notice it in the drawer, but cheap enough it
    // doesn't show up on the performance trace.
    const intervalId = setInterval(sweepStaleCallSessions, 3_000);
    return () => clearInterval(intervalId);
  }, [sweepStaleCallSessions]);

  // --- helper: find app id from sip id (with fallback to self-mapping) ---
  // Only onSessionAdded is allowed to mint a self-mapping — that's the event
  // that actually creates the CallSession. If onSessionChanged arrives first
  // (jssip fires 'peerconnection'/'progress' events before the outer
  // newRTCSession listener has a chance to emit onSessionAdded) the event
  // must NOT create a phantom mapping, otherwise onSessionAdded later sees
  // a non-null existingAppId and skips the invite-correlation pass.
  const resolveAppId = useCallback((sipSessionId: string, allowMint: boolean): string | null => {
    const existing = sipToAppIdRef.current.get(sipSessionId);
    if (existing) return existing;
    if (!allowMint) return null;
    sipToAppIdRef.current.set(sipSessionId, sipSessionId);
    return sipSessionId;
  }, []);

  // Handlers live in refs so the listener registration runs exactly once and
  // always dispatches through the latest closure. Avoids TDZ / stale-callback
  // issues from forward references (handlers reference postBackendHold which
  // is declared lower in the component).
  const onSipSessionAddedRef = useRef<(info: SipSessionInfo) => void>(() => {});
  const onSipSessionChangedRef = useRef<(info: SipSessionInfo) => void>(() => {});
  const onSipSessionRemovedRef = useRef<(id: string) => void>(() => {});

  // Register the SIP event listener once on mount. Listener is a thin trampoline
  // that reads the current ref — this means the listener identity is stable
  // while still dispatching to fresh handlers on each render.
  useEffect(() => {
    const unregister = sip.registerMultiCallListener({
      onSessionAdded: (info) => onSipSessionAddedRef.current(info),
      onSessionStateChanged: (info) => onSipSessionChangedRef.current(info),
      onSessionRemoved: (id) => onSipSessionRemovedRef.current(id),
    });
    return unregister;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sip]);

  const onSipSessionAdded = useCallback(
    (info: SipSessionInfo) => {
      logMulti("MULTICALL", "sip_session_added", {
        sipSessionId: info.sessionId,
        direction: info.direction,
        state: info.state,
      });

      // Prune any phantom ringing rows from previous calls before we add a
      // new one — keeps the drawer from accumulating dead entries.
      sweepStaleCallSessions();

      let existingAppId = sipToAppIdRef.current.get(info.sessionId) ?? null;

      // Correlate an inbound SIP session with a previously-registered invite
      // (from the push layer). Without this, we end up with two CallSession
      // rows for the same real call — one from registerInboundInvite stuck
      // in ringing_inbound forever, and another from the SIP session that
      // actually drives the UI. The stale ringing row then lights up the
      // CallWaitingBanner on every incoming call.
      if (!existingAppId && info.direction === "inbound") {
        const snap = stateRef.current;
        const sipRemote = normaliseRemote(info.callerNumber);
        const match = Object.values(snap.callsById).find(
          (cs) =>
            cs.direction === "inbound" &&
            cs.sipSessionId === null &&
            cs.state === "ringing_inbound" &&
            normaliseRemote(cs.remoteNumber) === sipRemote,
        );
        if (match) {
          logMulti("MULTICALL", "correlate_inbound_invite_to_sip_session", {
            inviteAppId: match.id,
            sipSessionId: info.sessionId,
            remote: sipRemote,
          });
          existingAppId = match.id;
          sipToAppIdRef.current.set(info.sessionId, match.id);
          appToSipIdRef.current.set(match.id, info.sessionId);
          // Attach the sip pointer synchronously so subsequent event handlers
          // and answer flow find the linkage.
          mutate("correlate_inbound_invite:" + match.id, (prev) => {
            const existing = prev.callsById[match.id];
            if (!existing) return prev;
            return {
              ...prev,
              callsById: {
                ...prev.callsById,
                [match.id]: { ...existing, sipSessionId: info.sessionId },
              },
            };
          });
        }
      }

      if (existingAppId && stateRef.current.callsById[existingAppId]) {
        // Already known (e.g. registerInboundInvite ran first from the push
        // layer). Just ensure the sip pointer is attached and fall through
        // to onSipSessionChanged to sync state.
        onSipSessionChanged(info);
        return;
      }

      // New session appeared without a pre-existing CallSession — mint one.
      const appId = existingAppId ?? info.sessionId;
      sipToAppIdRef.current.set(info.sessionId, appId);

      const session: CallSession = {
        id: appId,
        sipSessionId: info.sessionId,
        direction: info.direction,
        remoteNumber: info.callerNumber || "Unknown",
        remoteName: info.callerDisplayName,
        state: sipToSessionState(info.state, info.isHeld),
        startedAt: Date.now(),
        answeredAt: null,
        heldAt: null,
        endedAt: null,
        pbxCallId: null,
        nativeUuid: null,
        canHold: false,
        canResume: false,
        canSwap: false,
      };

      // Outbound-while-busy policy (plan §1): if the user just dialed while
      // another call is active, put the previous active call on hold so the
      // new outbound can become active. This mirrors `beginOutbound` for the
      // case where the dial was triggered via SipContext.dial() directly
      // (i.e. the screen didn't go through CallSessionManager.beginOutbound).
      if (
        info.direction === "outbound" &&
        (info.state === "dialing" || info.state === "connecting" || info.state === "ringing")
      ) {
        const prevActive = stateRef.current.activeCallId;
        if (prevActive && prevActive !== appId) {
          const prev = stateRef.current.callsById[prevActive];
          if (prev?.sipSessionId && prev.state === "active") {
            logMulti("MULTICALL_HOLD", "outbound_autohold_on_session_added", {
              prev: prev.id,
              newCall: appId,
            });
            sip.holdSipSession(prev.sipSessionId);
            postBackendHold(prev).catch(() => undefined);
          }
        }
      }

      mutate("onSipSessionAdded:" + info.sessionId, (prev) => {
        const callsById = { ...prev.callsById, [appId]: session };
        let ringingCallIds = prev.ringingCallIds;
        let activeCallId = prev.activeCallId;
        if (session.state === "ringing_inbound") {
          if (!ringingCallIds.includes(appId)) {
            ringingCallIds = [...ringingCallIds, appId];
          }
        } else if (session.state === "dialing_outbound" || session.state === "connecting") {
          // Outbound becomes the new active pointer immediately. The previous
          // active has been held above (for the outbound-while-busy case).
          activeCallId = appId;
        }
        return { ...prev, callsById, ringingCallIds, activeCallId };
      });
    },
    [mutate, sip, sweepStaleCallSessions],
  );

  const onSipSessionChanged = useCallback(
    (info: SipSessionInfo) => {
      // Peek-only: if onSessionAdded hasn't created the mapping yet (jssip
      // emits progress/peerconnection events before our newRTCSession hook
      // has wired the callbacks up), we must NOT self-map here — doing so
      // would block the correlation pass in onSipSessionAdded and leave the
      // push-layer invite stranded in ringing_inbound forever.
      const appId = resolveAppId(info.sessionId, /* allowMint */ false);
      if (!appId) return;
      const nextState = sipToSessionState(info.state, info.isHeld);

      mutate("onSipSessionChanged:" + info.sessionId + "->" + nextState, (prev) => {
        const existing = prev.callsById[appId];
        if (!existing) {
          // The session-added handler hasn't landed yet; skip — we'll pick it
          // up on the next event.
          return prev;
        }
        if (existing.state === nextState) return prev;

        const now = Date.now();
        const updated: CallSession = {
          ...existing,
          state: nextState,
          answeredAt:
            nextState === "active" && existing.answeredAt === null ? now : existing.answeredAt,
          heldAt:
            nextState === "held" && existing.heldAt === null ? now : existing.heldAt,
          endedAt: nextState === "ended" ? now : existing.endedAt,
          canHold: nextState === "active",
          canResume: nextState === "held",
          canSwap: nextState === "active",
        };

        let { activeCallId, heldCallIds, ringingCallIds } = prev;
        // remove this call from every bucket — we'll place it correctly below
        heldCallIds = heldCallIds.filter((x) => x !== appId);
        ringingCallIds = ringingCallIds.filter((x) => x !== appId);
        if (activeCallId === appId) activeCallId = null;

        switch (nextState) {
          case "ringing_inbound":
            ringingCallIds = [...ringingCallIds, appId];
            break;
          case "dialing_outbound":
          case "connecting":
            // Becomes the active pointer once we're past ringing (there is
            // only one outbound-placing call at a time by policy).
            if (!activeCallId) activeCallId = appId;
            break;
          case "active":
            activeCallId = appId;
            break;
          case "held":
            // LIFO: push to front of held stack.
            heldCallIds = [appId, ...heldCallIds];
            break;
          case "ended":
            // Don't re-enter any bucket; removal is handled in onSipSessionRemoved.
            break;
          case "ending":
            break;
        }

        return {
          ...prev,
          activeCallId,
          heldCallIds,
          ringingCallIds,
          callsById: { ...prev.callsById, [appId]: updated },
        };
      });
    },
    [mutate, resolveAppId],
  );

  const onSipSessionRemoved = useCallback(
    (sipSessionId: string) => {
      const appId =
        sipToAppIdRef.current.get(sipSessionId) ?? sipSessionId;
      sipToAppIdRef.current.delete(sipSessionId);

      let endedWasActive = false;

      mutate("onSipSessionRemoved:" + sipSessionId, (prev) => {
        const existing = prev.callsById[appId];
        if (!existing) return prev;
        endedWasActive = prev.activeCallId === appId;
        const callsById = { ...prev.callsById };
        delete callsById[appId];
        return {
          activeCallId: prev.activeCallId === appId ? null : prev.activeCallId,
          heldCallIds: prev.heldCallIds.filter((x) => x !== appId),
          ringingCallIds: prev.ringingCallIds.filter((x) => x !== appId),
          callsById,
        };
      });

      // NOTE: LIFO auto-resume was removed intentionally.
      // Product requirement: when the active call ends while other calls
      // are held, the held calls must STAY held. The user explicitly
      // resumes via the Hold/Resume button (when only one held call is
      // left) or the CallsDrawer row menu. Auto-unholding on behalf of
      // the user caused surprise audio in the wrong direction — e.g. a
      // third party suddenly hearing them — so we now require an
      // explicit resume gesture.
      if (endedWasActive) {
        const snap = stateRef.current;
        logMulti("MULTICALL_RESUME", "active_ended_keeping_held_on_hold", {
          remainingHeld: snap.heldCallIds,
          remainingRinging: snap.ringingCallIds,
        });
      }
    },
    [mutate],
  );

  // -------------------------------------------------------------------------
  // Backend state bookkeeping (non-blocking — best effort).
  // -------------------------------------------------------------------------
  const postBackendHold = useCallback(
    async (session: CallSession) => {
      if (!authToken) return;
      // Only invites (inbound) have a CallInvite row. Outbound-dial calls are
      // tracked elsewhere; we still SIP-hold them, just skip the REST call.
      if (session.direction !== "inbound") return;
      try {
        await holdCallInvite(authToken, session.id);
      } catch (err) {
        console.warn("[MULTICALL_BACKEND] hold api failed:", err);
      }
    },
    [authToken],
  );

  const postBackendResume = useCallback(
    async (session: CallSession) => {
      if (!authToken) return;
      if (session.direction !== "inbound") return;
      try {
        await resumeCallInvite(authToken, session.id);
      } catch (err) {
        console.warn("[MULTICALL_BACKEND] resume api failed:", err);
      }
    },
    [authToken],
  );

  // -------------------------------------------------------------------------
  // Actions exposed to screens.
  // -------------------------------------------------------------------------
  const holdActive = useCallback((): boolean => {
    const snap = stateRef.current;
    if (!snap.activeCallId) return false;
    const active = snap.callsById[snap.activeCallId];
    if (!active || !active.sipSessionId) return false;
    logMulti("MULTICALL_HOLD", "hold_active", {
      callId: active.id,
      sipSessionId: active.sipSessionId,
    });
    const ok = sip.holdSipSession(active.sipSessionId);
    if (ok) postBackendHold(active).catch(() => undefined);
    return ok;
  }, [sip, postBackendHold]);

  const answerWaiting = useCallback(
    async (callId: string): Promise<boolean> => {
      const snap = stateRef.current;
      const target = snap.callsById[callId];
      if (!target) {
        logMulti("MULTICALL", "answer_waiting_unknown_call", { callId });
        return false;
      }
      if (!target.sipSessionId) {
        logMulti("MULTICALL", "answer_waiting_no_sip_session_yet", { callId });
        return false;
      }
      // If there's already an active call, hold it first. We do NOT await
      // the hold success — JsSIP sends the re-INVITE asynchronously and the
      // answer can proceed in parallel. The answer's 200 OK won't race
      // because the two dialogs are independent.
      if (snap.activeCallId && snap.activeCallId !== callId) {
        const prevActive = snap.callsById[snap.activeCallId];
        if (prevActive?.sipSessionId) {
          logMulti("MULTICALL_HOLD", "holding_prev_active_before_answer", {
            prev: prevActive.id,
            newCall: callId,
          });
          sip.holdSipSession(prevActive.sipSessionId);
          postBackendHold(prevActive).catch(() => undefined);
        }
      }
      logMulti("MULTICALL", "answer_waiting", { callId });
      // Optimistic: pull the call out of ringingCallIds immediately so the
      // CallWaitingBanner closes the instant the user taps Answer. The real
      // 'connected' transition lands via onSipSessionChanged within ~300ms
      // but the UI must not linger on the ringing banner while we wait.
      mutate("answerWaiting_optimistic:" + callId, (prev) => {
        const existing = prev.callsById[callId];
        if (!existing) return prev;
        if (!prev.ringingCallIds.includes(callId) && existing.state !== "ringing_inbound") {
          return prev;
        }
        return {
          ...prev,
          callsById: {
            ...prev.callsById,
            [callId]: { ...existing, state: "connecting" },
          },
          ringingCallIds: prev.ringingCallIds.filter((x) => x !== callId),
        };
      });
      const ok = await sip.answerSipSession(target.sipSessionId, 5000);
      return ok;
    },
    [sip, postBackendHold, mutate],
  );

  const declineWaiting = useCallback(
    async (callId: string): Promise<boolean> => {
      const snap = stateRef.current;
      const target = snap.callsById[callId];
      if (!target?.sipSessionId) {
        logMulti("MULTICALL", "decline_waiting_no_session", { callId });
        return false;
      }
      logMulti("MULTICALL", "decline_waiting", { callId });
      return sip.hangupSipSession(target.sipSessionId);
    },
    [sip],
  );

  const resume = useCallback(
    (callId: string): boolean => {
      const snap = stateRef.current;
      const target = snap.callsById[callId];
      if (!target || !target.sipSessionId) {
        logMulti("MULTICALL_RESUME", "target_missing", { callId });
        return false;
      }

      // Swap semantics — current active goes on hold first.
      if (snap.activeCallId && snap.activeCallId !== callId) {
        const prevActive = snap.callsById[snap.activeCallId];
        if (prevActive?.sipSessionId) {
          logMulti("MULTICALL_HOLD", "swap_holding_prev_active", {
            prev: prevActive.id,
            resume: callId,
          });
          sip.holdSipSession(prevActive.sipSessionId);
          postBackendHold(prevActive).catch(() => undefined);
        }
      }

      logMulti("MULTICALL_RESUME", "manual_resume", { callId });
      const ok = sip.unholdSipSession(target.sipSessionId);
      if (ok) postBackendResume(target).catch(() => undefined);
      return ok;
    },
    [sip, postBackendHold, postBackendResume],
  );

  const swap = useCallback((targetId: string) => resume(targetId), [resume]);

  const hangup = useCallback(
    async (callId: string): Promise<boolean> => {
      const snap = stateRef.current;
      const target = snap.callsById[callId];
      if (!target || !target.sipSessionId) {
        logMulti("MULTICALL", "hangup_missing", { callId });
        return false;
      }
      logMulti("MULTICALL", "hangup", { callId, state: target.state });
      // The onSipSessionRemoved handler owns the LIFO auto-resume, so we
      // don't need to do it here.
      return sip.hangupSipSession(target.sipSessionId);
    },
    [sip],
  );

  const transfer = useCallback(
    (callId: string, targetNumber: string): boolean => {
      const snap = stateRef.current;
      const target = snap.callsById[callId];
      if (!target || !target.sipSessionId) {
        logMulti("MULTICALL", "transfer_missing_session", { callId });
        return false;
      }
      const clean = (targetNumber ?? "").trim();
      if (!clean) {
        logMulti("MULTICALL", "transfer_empty_target", { callId });
        return false;
      }
      logMulti("MULTICALL", "transfer", { callId, to: clean, state: target.state });
      return sip.transferSipSession(target.sipSessionId, clean);
    },
    [sip],
  );

  const beginOutbound = useCallback(
    ({
      callId,
      sipSessionId,
      remoteNumber,
    }: {
      callId: string;
      sipSessionId: string | null;
      remoteNumber: string;
    }) => {
      // Scrub any phantom ringing_inbound rows that lost their SIP
      // session (or never had one). Otherwise a zombie invite from the
      // backend's pending list would sit in the drawer next to the
      // outbound call we're about to start and the user would see
      // "INCOMING" next to their own outbound dial.
      sweepStaleCallSessions();
      const snap = stateRef.current;

      // Outbound-while-busy policy (plan §1): auto-hold the current active call.
      if (snap.activeCallId) {
        const active = snap.callsById[snap.activeCallId];
        if (active?.sipSessionId) {
          logMulti("MULTICALL_HOLD", "outbound_autohold_active", {
            prev: active.id,
            newCall: callId,
          });
          sip.holdSipSession(active.sipSessionId);
          postBackendHold(active).catch(() => undefined);
        }
      }

      const now = Date.now();
      const session: CallSession = {
        id: callId,
        sipSessionId,
        direction: "outbound",
        remoteNumber,
        remoteName: null,
        state: "dialing_outbound",
        startedAt: now,
        answeredAt: null,
        heldAt: null,
        endedAt: null,
        pbxCallId: null,
        nativeUuid: null,
        canHold: false,
        canResume: false,
        canSwap: false,
      };
      if (sipSessionId) {
        sipToAppIdRef.current.set(sipSessionId, callId);
      }
      appToSipIdRef.current.set(callId, sipSessionId ?? "");

      mutate("beginOutbound:" + callId, (prev) => ({
        ...prev,
        activeCallId: callId,
        callsById: { ...prev.callsById, [callId]: session },
      }));
    },
    [sip, postBackendHold, mutate, sweepStaleCallSessions],
  );

  const registerInboundInvite = useCallback(
    ({
      callId,
      remoteNumber,
      remoteName,
      pbxCallId,
    }: {
      callId: string;
      remoteNumber: string;
      remoteName?: string | null;
      pbxCallId: string | null;
    }) => {
      // Prune any phantom rows first so the concurrency check below and the
      // drawer UI only see actually-live calls.
      sweepStaleCallSessions();

      const snap = stateRef.current;
      if (snap.callsById[callId]) {
        logMulti("MULTICALL", "register_invite_dedup", { callId });
        return;
      }
      // Dedup by normalised remote number — if a ringing_inbound entry for
      // the same caller already exists with no SIP session, adopt it (don't
      // create a second phantom). The newer callId usually carries more
      // accurate display-name metadata from the push payload.
      const normalizedRemote = (remoteNumber ?? "").replace(/[^\d]/g, "");
      if (normalizedRemote) {
        const twin = Object.values(snap.callsById).find(
          (cs) =>
            cs.state === "ringing_inbound" &&
            cs.direction === "inbound" &&
            (cs.remoteNumber ?? "").replace(/[^\d]/g, "") === normalizedRemote,
        );
        if (twin) {
          logMulti("MULTICALL", "register_invite_dedup_by_remote", {
            keep: twin.id,
            drop: callId,
          });
          return;
        }
      }
      // Enforce the per-user limit at the manager layer too. (JsSIP already
      // rejects with 486 at the transport level — this logs the same decision.)
      const total =
        Object.keys(snap.callsById).length +
        (snap.activeCallId ? 0 : 0); // included above
      if (total >= MAX_CONCURRENT_CALLS) {
        logMulti("MULTICALL", "register_invite_at_limit — will be auto-486d", {
          callId,
          total,
        });
      }
      const session: CallSession = {
        id: callId,
        sipSessionId: null,
        direction: "inbound",
        remoteNumber,
        remoteName: remoteName ?? null,
        state: "ringing_inbound",
        startedAt: Date.now(),
        answeredAt: null,
        heldAt: null,
        endedAt: null,
        pbxCallId,
        nativeUuid: null,
        canHold: false,
        canResume: false,
        canSwap: false,
      };
      mutate("registerInboundInvite:" + callId, (prev) => ({
        ...prev,
        callsById: { ...prev.callsById, [callId]: session },
        ringingCallIds: prev.ringingCallIds.includes(callId)
          ? prev.ringingCallIds
          : [...prev.ringingCallIds, callId],
      }));
      // Call-waiting audible alert: if a call is already active (connected)
      // when this new inbound invite arrives, play the short SAS beep so the
      // user can HEAR a new call is coming in without disturbing the active
      // conversation. Skipped when the device is idle so the full incoming
      // ringtone owns the audio.
      if (snap.activeCallId) {
        const active = snap.callsById[snap.activeCallId];
        if (active && active.state === "connected") {
          logMulti("MULTICALL", "call_waiting_beep", { callId });
          try {
            playCallWaitingBeep().catch(() => undefined);
          } catch {
            /* best-effort — never block inbound invite registration */
          }
        }
      }
    },
    [mutate, sweepStaleCallSessions],
  );

  const removeInboundInvite = useCallback(
    (callId: string, reason?: string) => {
      mutate("removeInboundInvite:" + callId + (reason ? `:${reason}` : ""), (prev) => {
        const existing = prev.callsById[callId];
        if (!existing) return prev;
        // If a SIP session is already attached, let the SIP tear-down path
        // handle removal to keep sip/app id bookkeeping in sync.
        if (existing.sipSessionId) {
          logMulti("MULTICALL", "remove_invite_skipped_sip_attached", {
            callId,
            reason: reason ?? null,
          });
          return prev;
        }
        const callsById = { ...prev.callsById };
        delete callsById[callId];
        logMulti("MULTICALL", "remove_invite", { callId, reason: reason ?? null });
        return {
          activeCallId: prev.activeCallId === callId ? null : prev.activeCallId,
          heldCallIds: prev.heldCallIds.filter((x) => x !== callId),
          ringingCallIds: prev.ringingCallIds.filter((x) => x !== callId),
          callsById,
        };
      });
    },
    [mutate],
  );

  const attachSipSession = useCallback(
    (callId: string, sipSessionId: string) => {
      logMulti("MULTICALL", "attach_sip_session", { callId, sipSessionId });
      sipToAppIdRef.current.set(sipSessionId, callId);
      appToSipIdRef.current.set(callId, sipSessionId);
      mutate("attachSipSession:" + callId, (prev) => {
        const existing = prev.callsById[callId];
        if (!existing) return prev;
        if (existing.sipSessionId === sipSessionId) return prev;
        return {
          ...prev,
          callsById: {
            ...prev.callsById,
            [callId]: { ...existing, sipSessionId },
          },
        };
      });
    },
    [mutate],
  );

  const hydrateOnReconnect = useCallback(async (): Promise<void> => {
    if (!authToken) return;
    try {
      const res = await getActiveAndHeldInvites(authToken);
      const active = res.active;
      const held = res.held;
      logMulti("MULTICALL", "hydrate_on_reconnect", {
        active: active?.id ?? null,
        heldCount: held.length,
      });
      // The server tells us which invites are logically active/held. Live SIP
      // sessions may not exist after a cold start — in that case we mark them
      // ended in local state so UI doesn't render a phantom stack. If SIP
      // sessions DO exist (hot reconnect), onSipSessionAdded already populated
      // the entries; we just confirm their buckets.
      mutate("hydrate_on_reconnect", (prev) => {
        const next = { ...prev };
        // Drop calls that the server no longer considers live.
        const live = new Set<string>();
        if (active?.id) live.add(active.id);
        for (const h of held) live.add(h.id);
        const pruned: Record<string, CallSession> = {};
        for (const [id, s] of Object.entries(prev.callsById)) {
          if (s.direction === "outbound" || live.has(id)) pruned[id] = s;
        }
        next.callsById = pruned;
        next.activeCallId = prev.activeCallId && pruned[prev.activeCallId] ? prev.activeCallId : null;
        next.heldCallIds = prev.heldCallIds.filter((id) => pruned[id]);
        next.ringingCallIds = prev.ringingCallIds.filter((id) => pruned[id]);
        return next;
      });
    } catch (err) {
      console.warn("[MULTICALL] hydrate_on_reconnect_failed:", err);
    }
  }, [authToken, mutate]);

  // Auto-hydrate when the auth token shows up.
  useEffect(() => {
    if (!authToken) return;
    hydrateOnReconnect().catch(() => undefined);
  }, [authToken, hydrateOnReconnect]);

  // Also re-hydrate whenever the app comes back to the foreground. This
  // catches the case where the OS killed the JS context while a call was
  // active/held on the server — without this, the app would render idle while
  // the PBX still considers the user on a call.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next !== "active") return;
      if (!authToken) return;
      logMulti("MULTICALL", "appstate_active_hydrate");
      hydrateOnReconnect().catch(() => undefined);
    });
    return () => sub.remove();
  }, [authToken, hydrateOnReconnect]);

  // Push the busy flag to the Android IncomingCallFirebaseService so that
  // native code can suppress the loud ringtone + full-screen intent when a
  // new INVITE arrives while another call is already active. The flag is a
  // static boolean on the service class; one setter call per change is
  // enough because the flag persists across service rebirths within the
  // same process.
  const inActiveCallRef = useRef<boolean>(false);
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const hasActive = state.activeCallId !== null;
    if (hasActive === inActiveCallRef.current) return;
    inActiveCallRef.current = hasActive;
    try {
      const mod = NativeModules.IncomingCallUi;
      if (mod && typeof mod.setInActiveCall === "function") {
        logMulti("MULTICALL", "native_busy_flag_update", { hasActive });
        mod.setInActiveCall(hasActive);
      }
    } catch (err) {
      console.warn("[MULTICALL] setInActiveCall bridge threw:", err);
    }
  }, [state.activeCallId]);

  // Keep the SIP listener refs pointing at the freshest callbacks so each
  // event dispatches with up-to-date closures (postBackendHold, sip, mutate).
  useEffect(() => {
    onSipSessionAddedRef.current = onSipSessionAdded;
    onSipSessionChangedRef.current = onSipSessionChanged;
    onSipSessionRemovedRef.current = onSipSessionRemoved;
  }, [onSipSessionAdded, onSipSessionChanged, onSipSessionRemoved]);

  // -------------------------------------------------------------------------
  // Derived projections — kept stable with useMemo so screens that consume
  // `heldCalls` don't re-render on every unrelated state change.
  // -------------------------------------------------------------------------
  const value = useMemo<CallSessionManagerContextValue>(() => {
    const activeCall = state.activeCallId
      ? state.callsById[state.activeCallId] ?? null
      : null;
    const heldCalls = state.heldCallIds
      .map((id) => state.callsById[id])
      .filter((x): x is CallSession => !!x);
    const ringingCalls = state.ringingCallIds
      .map((id) => state.callsById[id])
      .filter((x): x is CallSession => !!x);

    // Authoritative "is the app currently engaged in ANY call?" flag. True
    // when we have an active call, a held call, a confirmed-ringing inbound
    // Used by the notification layer + RootNavigator to suppress the
    // full-screen IncomingCallScreen for SECONDARY invites while a prior
    // call is already engaged. Covers the answer→connecting race so a
    // new invite never yanks the user off the ActiveCallScreen.
    //
    // IMPORTANT: `ringing_inbound` is intentionally NOT included here.
    // A ringing_inbound row is the incoming call itself — not a prior
    // engaged call. Including it would make a brand-new inbound call
    // (no previous session) count as "ongoing" the moment the SIP
    // INVITE lands, which in turn causes the IncomingCallScreen to be
    // suppressed and the user sees nothing (there is no ActiveCallScreen
    // mounted yet to host the drawer). The answer action transitions
    // the state to `connecting`/`active`, which this flag still sees.
    const hasAnyOngoingCall = Object.values(state.callsById).some(
      (cs) =>
        cs.state === "active" ||
        cs.state === "held" ||
        cs.state === "connecting" ||
        cs.state === "dialing_outbound",
    );

    return {
      state,
      getSession: (id: string) => state.callsById[id] ?? null,
      activeCall,
      heldCalls,
      ringingCalls,
      hasAnyOngoingCall,
      answerWaiting,
      declineWaiting,
      holdActive,
      resume,
      swap,
      hangup,
      transfer,
      beginOutbound,
      registerInboundInvite,
      removeInboundInvite,
      attachSipSession,
      hydrateOnReconnect,
    };
  }, [
    state,
    answerWaiting,
    declineWaiting,
    holdActive,
    resume,
    swap,
    hangup,
    transfer,
    beginOutbound,
    registerInboundInvite,
    removeInboundInvite,
    attachSipSession,
    hydrateOnReconnect,
  ]);

  // Suppress "never read" warning on Platform — retained because future
  // platform-specific hooks (iOS CallKit bridge) will live here.
  void Platform;

  return (
    <CallSessionManagerContext.Provider value={value}>
      {children}
    </CallSessionManagerContext.Provider>
  );
}

// ---------- Hook ----------
export function useCallSessions(): CallSessionManagerContextValue {
  const ctx = useContext(CallSessionManagerContext);
  if (!ctx) {
    throw new Error("useCallSessions must be used within CallSessionProvider");
  }
  return ctx;
}
