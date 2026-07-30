import { AppState, NativeModules, Platform } from "react-native";
import RNCallKeep from "react-native-callkeep";
import { logCallFlow } from "../debug/callFlowDebug";
import { deterministicCallKitUuid } from "./callkitUuid";
import { getMobileIncomingRingtone, type MobileRingtoneId } from "../audio/ringtonePreferences";
import { appendIosRingLog } from "../diagnostics/iosRingLog";

// iOS ONLY: filename of the silent WAV bundled by
// plugins/withIosSilentRingtone.js. Must stay in sync with
// SILENT_RINGTONE_FILENAME there. Handing this to CallKit as its own
// `ringtoneSound` mutes CallKit's native ring so the JS-managed "Connect
// Default" ringtone (src/audio/telephonyAudio.ts) is the only audible sound,
// without skipping the native CallKit report (still Apple-compliant) and
// without touching the SIP/invite/answer pipeline. Unused on Android.
const SILENT_RINGTONE_FILENAME = "connect-silent-ringtone.wav";

// iOS ONLY: the REAL Connect ringtone as a CallKit-playable bundled sound file
// (see plugins/withIosConnectRingtone.js). CallKit can only play a bundled file
// - not JS - so this is what rings a backgrounded / force-quit iPhone with the
// Connect ringtone. RNCallKeep persists this filename into NSUserDefaults on
// setup() and reads it back at cold start (initCallKitProvider), so the choice
// survives a fully killed launch with no JS involved.
const CONNECT_RINGTONE_FILENAME = "connect-default-ringtone.caf";

/** iOS ONLY: `ios.ringtoneSound` for the given preference — undefined for
 *  "classic" so CallKit keeps using the phone's real system ringtone
 *  (unchanged behavior); the silent file for "connect-default" so only the
 *  JS ringtone is heard. Android callers never read this value. */
function iosRingtoneSoundFor(preference: MobileRingtoneId): string | undefined {
  // The silent file is intentionally retained (still bundled by
  // plugins/withIosSilentRingtone.js) for reference / future foreground
  // suppression use. The background/killed ring MUST be the real .caf because a
  // warm-backgrounded device cannot play JS audio - CallKit itself must ring.
  void SILENT_RINGTONE_FILENAME;
  return preference === "connect-default" ? CONNECT_RINGTONE_FILENAME : undefined;
}

// ── iOS CallKit identity mapping ─────────────────────────────────────────────
// CallKit (iOS) requires a valid RFC-4122 UUID for every call. The Connect
// backend identifies a call by `callId`/`inviteId` (a cuid like "clx…"), which
// is NOT a valid UUID — passing it straight to CallKit makes
// `[[NSUUID alloc] initWithUUIDString:]` return nil and the call report
// silently fails. We therefore keep a bidirectional, in-process map so:
//   • outgoing CallKit calls use a generated UUID, and
//   • the `answerCall` / `endCall` events (which carry the UUID) are translated
//     back to the original callId before reaching the shared answer/decline
//     pipeline.
//
// On Android these maps stay EMPTY (showIncomingNativeCall is only ever invoked
// on iOS), so every lookup falls through to the raw callId and Android behavior
// is byte-for-byte unchanged.
const callIdToCallKitUuid = new Map<string, string>();
const callKitUuidToCallId = new Map<string, string>();
// Sibling call-id associations (invite-id <-> pbxCallId). One inbound call is
// reported to CallKit under different ids by different push paths (the wake push
// uses the PBX call-id, the live invite uses the invite id). Recording the pair
// lets endNativeCall() tear down EVERY CallKit call for the same phone call, so
// a cancel/hangup/voicemail never leaves a second call ringing on the lock
// screen or lingering as the green "active call" pill.
const siblingCallIds = new Map<string, Set<string>>();

export function associateCallIds(
  a: string | null | undefined,
  b: string | null | undefined,
): void {
  if (!a || !b || a === b) return;
  if (!siblingCallIds.has(a)) siblingCallIds.set(a, new Set());
  if (!siblingCallIds.has(b)) siblingCallIds.set(b, new Set());
  siblingCallIds.get(a)!.add(b);
  siblingCallIds.get(b)!.add(a);
  // COWORK build 20 (2026-07-16): siblings are the SAME phone call under two
  // backend ids — feed the alias map so all CallKit operations collapse onto
  // ONE call (see callKitCallIdAlias below). iOS-only state; on Android these
  // maps are never read.
  if (Platform.OS === "ios") {
    const canonical = reportedIncomingCallIds.has(b) && !reportedIncomingCallIds.has(a) ? b : a;
    const alias = canonical === a ? b : a;
    if (callKitCallIdAlias.get(alias) !== canonical) {
      callKitCallIdAlias.set(alias, canonical);
      console.log("[CALL_INCOMING] associateCallIds → alias:", alias, "->", canonical);
    }
  }
}

// callIds already reported to CallKit — dedupe so a device that receives BOTH
// an Expo push and a VoIP push (or repeated VoIP retries) does not create two
// CallKit calls / two visible incoming UIs.
const reportedIncomingCallIds = new Set<string>();

// COWORK build 20 (2026-07-16): one inbound call arrives as TWO pushes with
// DIFFERENT backend ids — a caller-less PREWAKE VoIP push carrying the PBX
// callId, then ~350ms later the full INCOMING_CALL push carrying the invite
// cuid. Reporting each id separately created TWO CallKit calls per inbound
// call (live-traced 2026-07-16): the lock screen showed the caller-less one
// ("Unknown"), and teardown — which ends by invite id — left the other
// CallKit call live, a zombie that kept iOS's green status-bar pill up after
// hangup. The alias map folds the second id onto the first ("placeholder")
// so there is exactly ONE CallKit call. `callerlessReportedCallIds` tracks
// placeholders (reported with an empty `from`) — only those are fold targets,
// so two genuinely concurrent calls with real callers are never merged.
// iOS-ONLY: nothing populates or reads these on Android.
const callKitCallIdAlias = new Map<string, string>();
const callerlessReportedCallIds = new Set<string>();

function resolveNativeCallId(callId: string): string {
  return callKitCallIdAlias.get(callId) ?? callId;
}

/** Stable CallKit UUID for a backend callId.
 *
 *  DETERMINISTIC: derived from callId via deterministicCallKitUuid so the native
 *  PushKit handler (plugins/withIosVoipPush.js) and JS compute the SAME UUID for
 *  a fully cold-killed call — no shared runtime state required. We still cache
 *  both directions so callIdForCallKitUuid() can reverse a CallKit answer/end
 *  event (which only carries the UUID) back to the backend callId. */
export function callKitUuidForCallId(callId: string): string {
  let uuid = callIdToCallKitUuid.get(callId);
  if (!uuid) {
    uuid = deterministicCallKitUuid(callId);
    callIdToCallKitUuid.set(callId, uuid);
    callKitUuidToCallId.set(uuid, callId);
  }
  return uuid;
}

/** Translate a CallKit UUID back to the backend callId (null if unmapped, e.g.
 *  Android, where the raw callId is used directly). */
export function callIdForCallKitUuid(uuid: string): string | null {
  return callKitUuidToCallId.get(uuid) ?? null;
}

function forgetCallKitMapping(callIdOrUuid: string): void {
  const mappedUuid = callIdToCallKitUuid.get(callIdOrUuid);
  if (mappedUuid) {
    callIdToCallKitUuid.delete(callIdOrUuid);
    callKitUuidToCallId.delete(mappedUuid);
  }
  const mappedCallId = callKitUuidToCallId.get(callIdOrUuid);
  if (mappedCallId) {
    callKitUuidToCallId.delete(callIdOrUuid);
    callIdToCallKitUuid.delete(mappedCallId);
  }
}

/** Android: cancel native incoming notification + stop native ringtone immediately. */
export function dismissNativeIncomingUi(callId: string | null | undefined) {
  if (Platform.OS !== "android") {
    console.log("[NATIVE_DISMISS] skip not-android callId=" + callId);
    return;
  }
  if (!callId) {
    console.log("[NATIVE_DISMISS] skip empty callId");
    return;
  }
  const mod = NativeModules.IncomingCallUi;
  if (!mod || typeof mod.dismiss !== "function") {
    console.warn("[NATIVE_DISMISS] IncomingCallUi module missing, callId=" + callId);
    return;
  }
  try {
    console.log("[NATIVE_DISMISS] invoking IncomingCallUi.dismiss callId=" + callId);
    mod.dismiss(callId);
    console.log("[NATIVE_DISMISS] returned from IncomingCallUi.dismiss callId=" + callId);
  } catch (e) {
    console.warn("[NATIVE_DISMISS] IncomingCallUi.dismiss threw:", String(e));
  }
}

/** Android: clear show-when-locked / turn-screen-on after calls (avoids blank trap after hangup). */
export function clearAndroidLockScreenCallPresentation() {
  if (Platform.OS !== "android") return;
  try {
    NativeModules.IncomingCallUi?.clearLockScreenCallPresentation?.();
  } catch {
    // ignore
  }
}

/**
 * Android: move the app task to the background.
 * Used after a call ends that was answered from the lock screen — reveals
 * the lock screen instead of leaving the app's Quick page on top of it.
 */
export function moveAppToBackground() {
  if (Platform.OS !== "android") return;
  try {
    NativeModules.IncomingCallUi?.moveToBackground?.();
  } catch {
    // ignore
  }
}

let configured = false;

export async function setupNativeCalling() {
  if (configured) return;
  // iOS ONLY: read the user's ringtone preference so the very first CallKit
  // setup already has the right ringtoneSound. Android ignores this value
  // (RNCallKeep only reads ios.ringtoneSound on iOS), so this is a no-op read
  // there beyond the AsyncStorage lookup.
  const preference = await getMobileIncomingRingtone().catch(() => "connect-default" as MobileRingtoneId);
  const options: any = {
    ios: {
      appName: "Connect Communications",
      supportsVideo: false,
      ringtoneSound: iosRingtoneSoundFor(preference),
    },
    android: {
      alertTitle: "Phone account permission",
      alertDescription: "This app needs phone account access to show incoming call UI.",
      cancelButton: "Cancel",
      okButton: "ok"
    }
  };
  try {
    await RNCallKeep.setup(options);
    RNCallKeep.setAvailable(true);
    configured = true;
  } catch {
    configured = false;
  }
}

/**
 * iOS ONLY: re-configure CallKit's own ringtone sound after the user changes
 * the "Incoming Ringtone" setting mid-session (Settings screen calls this
 * right after setMobileIncomingRingtone). Safe to call repeatedly — it just
 * re-applies the CXProviderConfiguration. No-op on Android (RNCallKeep.setup
 * is harmless to re-call there too, but nothing reads ios.ringtoneSound).
 */
export async function applyIosRingtonePreference(preference: MobileRingtoneId): Promise<void> {
  if (Platform.OS !== "ios") return;
  try {
    await RNCallKeep.setup({
      ios: {
        appName: "Connect Communications",
        supportsVideo: false,
        ringtoneSound: iosRingtoneSoundFor(preference),
      },
    } as any);
  } catch (e) {
    console.warn("[CallKeep] applyIosRingtonePreference failed:", String(e));
  }
}

// COWORK build 20 (2026-07-16, owner request): `from` is the NUMBER (CallKit
// handle) and `callerName` the display name / CNAM. Passing them separately
// makes iOS render its native two-line incoming UI — name (or caller ID) on
// top, number underneath. Callers that pass only `from` behave exactly as
// before (name falls back to the number). Android call sites are iOS-gated
// and never reach this function.
export function showIncomingNativeCall(callId: string, from: string, callerName?: string | null) {
  // iOS ONLY: dedupe (an iPhone may receive both an Expo push and a VoIP push
  // for the same call → report to CallKit at most once per callId) and map the
  // callId to a real CallKit UUID. Android must run its original path untouched,
  // so none of this executes on Android — it falls straight through to the raw
  // callId, byte-for-byte identical to the pre-iOS behavior.
  if (Platform.OS === "ios") {
    callId = resolveNativeCallId(callId);
    const trimmedFrom = (from || "").trim();
    const trimmedName = (callerName || "").trim();
    // COWORK build 20: if this report has a REAL caller and a caller-less
    // PREWAKE placeholder is still reported, this is the second push of the
    // SAME call under a different backend id. Fold it onto the placeholder
    // (alias + fall into the update path below) instead of reporting a second
    // CallKit call — see the alias map comment above.
    if (!reportedIncomingCallIds.has(callId) && trimmedFrom) {
      for (const placeholderId of callerlessReportedCallIds) {
        if (placeholderId !== callId && reportedIncomingCallIds.has(placeholderId)) {
          callKitCallIdAlias.set(callId, placeholderId);
          console.log("[CALL_INCOMING] folded second-push callId into placeholder:", callId, "->", placeholderId);
          callId = placeholderId;
          break;
        }
      }
    }
    if (reportedIncomingCallIds.has(callId)) {
      // Already reported to CallKit — commonly by a caller-less PREWAKE VoIP
      // push that displayed "Unknown". If we now have a real caller (the full
      // INCOMING_CALL push / resolved invite), UPDATE the CallKit label instead
      // of dropping it, so the incoming screen shows the number/name rather than
      // "Unknown" (COWORK fix 2026-07-13). No-op when `from` is empty. Android
      // never reaches this branch.
      if (trimmedFrom) {
        try {
          const u = callKitUuidForCallId(callId);
          // CallKit's lock screen renders ONE line (a second line is reserved
          // by Apple for the app name — stacking is impossible). NAME FIRST,
          // number after (owner decision 2026-07-30). Number-only callers
          // show the number alone.
          const combined =
            trimmedName && trimmedName !== trimmedFrom
              ? `${trimmedName} · ${trimmedFrom}`
              : trimmedFrom;
          (RNCallKeep as any).updateDisplay?.(u, combined, trimmedFrom);
          callerlessReportedCallIds.delete(callId);
          console.log("[CALL_INCOMING] showIncomingNativeCall: refreshed CallKit label for already-reported callId=", callId, "from=", trimmedFrom, "name=", trimmedName);
        } catch (e) {
          console.warn("[CALL_INCOMING] updateDisplay failed:", String(e));
        }
      } else {
        console.log("[CALL_INCOMING] showIncomingNativeCall: duplicate callId ignored (no caller to refresh) callId=", callId);
      }
      return;
    }
    reportedIncomingCallIds.add(callId);
    if (!trimmedFrom) callerlessReportedCallIds.add(callId);
  }
  const uuid = Platform.OS === "ios" ? callKitUuidForCallId(callId) : callId;
  console.log("[CALL_INCOMING] showIncomingNativeCall (foreground) callId=", callId, "uuid=", uuid, "from=", from);
  logCallFlow("CALLKEEP_DISPLAY_BEGIN", {
    inviteId: callId,
    extra: { from, source: "showIncomingNativeCall", uuid },
  });
  try {
    void appendIosRingLog("IOS_JS_CALLKIT_REPORT", { callId, uuid, appState: AppState.currentState });
    // displayIncomingCall(uuid, handle, localizedCallerName, …): CallKit's
    // lock screen shows ONLY localizedCallerName (Apple reserves the second
    // line for the app name — stacking is impossible). NAME FIRST, number
    // after (owner decision 2026-07-30). Number-only callers show the
    // number alone. Android never reaches here (all call sites are iOS-gated).
    const trimmedCallerName = (callerName || "").trim();
    const displayName =
      Platform.OS === "ios"
        ? trimmedCallerName && trimmedCallerName !== from
          ? `${trimmedCallerName} · ${from}`
          : from
        : from;
    RNCallKeep.displayIncomingCall(uuid, from, displayName, "number", false);
    console.log("[CALL_INCOMING] showIncomingNativeCall: displayIncomingCall returned");
    logCallFlow("CALLKEEP_DISPLAY_DONE", {
      inviteId: callId,
      extra: { from, source: "showIncomingNativeCall" },
    });
  } catch (e) {
    console.error("[CALL_INCOMING] showIncomingNativeCall FAILED:", e);
    logCallFlow("CALLKEEP_DISPLAY_FAILED", {
      inviteId: callId,
      extra: { message: e instanceof Error ? e.message : String(e) },
    });
  }
}

export function endNativeCall(callId: string) {
  // COWORK build 20 (2026-07-16): resolve a second-push alias to the one real
  // CallKit call (see callKitCallIdAlias) so ending by EITHER backend id kills
  // the call the user is looking at — previously the invite-id end was a no-op
  // on the placeholder call, leaving a zombie CallKit call (stuck green
  // system pill). Also end any sibling-reported CallKit calls (pre-alias
  // races where both ids were reported). Android: alias/sibling state is
  // never populated → identity, unchanged behavior.
  if (Platform.OS === "ios") {
    callId = resolveNativeCallId(callId);
    callerlessReportedCallIds.delete(callId);
    const sibs = siblingCallIds.get(callId);
    if (sibs) {
      for (const sib of sibs) {
        const sibResolved = resolveNativeCallId(sib);
        if (sibResolved === callId) continue;
        reportedIncomingCallIds.delete(sibResolved);
        callerlessReportedCallIds.delete(sibResolved);
        try {
          RNCallKeep.endCall(callIdToCallKitUuid.get(sibResolved) ?? callKitUuidForCallId(sibResolved));
        } catch {
          // ignore
        }
      }
    }
  }
  siblingCallIds.delete(callId);
  reportedIncomingCallIds.delete(callId);
  dismissNativeIncomingUi(callId);
  // iOS: ALWAYS resolve to the deterministic CallKit UUID so we end the exact
  // call the native PushKit handler reported — even on a cold-killed cancel
  // where JS never populated the map yet (callKitUuidForCallId recomputes the
  // same deterministic value the native side used).
  // Android: the map stays empty, so this is the raw callId — unchanged behavior.
  const uuid =
    Platform.OS === "ios"
      ? callIdToCallKitUuid.get(callId) ?? callKitUuidForCallId(callId)
      : callIdToCallKitUuid.get(callId) ?? callId;
  try {
    RNCallKeep.endCall(uuid);
  } catch {
    // ignore
  }
  forgetCallKitMapping(callId);
}

// ── iOS CallKit audio-session activation tracking (2026-07-30) ──────────────
// THE dead-mic root cause on release builds: answering from the lock screen,
// the (fast) release build ran getUserMedia BEFORE CallKit's
// didActivateAudioSession handoff, so the capture unit opened against an
// inactive session and recorded silence. (Debug/dev-client builds are slow
// enough to always lose that race — mic "worked in dev, died in prod".)
// Outbound calls never involve the CallKit handoff — proven on-device:
// outbound mic fine, incoming mic dead. The answer path awaits this signal.
let iosAudioSessionActive = false;
let iosAudioSessionWaiters: Array<() => void> = [];

function markIosAudioSessionActive(active: boolean) {
  iosAudioSessionActive = active;
  if (active) {
    const waiters = iosAudioSessionWaiters;
    iosAudioSessionWaiters = [];
    for (const w of waiters) {
      try { w(); } catch { /* ignore */ }
    }
  }
}

/** Resolves when CallKit has activated the audio session (immediately if it
 *  already has), or after `timeoutMs` as a fail-open so an odd CallKit state
 *  can never block answering. Returns whether activation was actually seen. */
export function waitForIosAudioSessionActivation(timeoutMs: number): Promise<boolean> {
  if (Platform.OS !== "ios") return Promise.resolve(true);
  if (iosAudioSessionActive) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (seen: boolean) => {
      if (settled) return;
      settled = true;
      resolve(seen);
    };
    iosAudioSessionWaiters.push(() => done(true));
    setTimeout(() => done(false), Math.max(50, timeoutMs));
  });
}

export function subscribeNativeCallActions(params: {
  onAnswer: (callId: string) => void;
  onEnd: (callId: string) => void;
}) {
  // iOS ONLY — MUST be attached BEFORE the answerCall/endCall listeners below.
  //
  // When the app is cold-killed and the user answers a CallKit call on the lock
  // screen BEFORE the JS bridge finishes booting, RNCallKeep buffers the
  // answer/end action natively (`_delayedEvents`) and delivers it ONLY through
  // this one-shot `didLoadWithEvents` event, which fires when the FIRST JS
  // listener attaches (startObserving). Without this subscription the tap is
  // silently discarded: CallKit flips to "answered" but the SIP pipeline never
  // runs — the exact "answered the call and nothing happened" lock-screen bug.
  // Ordering matters: attaching answerCall first would trigger the flush with
  // nobody listening.
  let didLoadSub: { remove: () => void } | null = null;
  let audioActivateSub: { remove: () => void } | null = null;
  let audioDeactivateSub: { remove: () => void } | null = null;
  if (Platform.OS === "ios") {
    // didLoadWithEvents MUST stay the FIRST RNCallKeep listener attached — the
    // native buffer flushes on the first observer, and only this listener can
    // catch it (cold-start answer taps live in that buffer).
    didLoadSub = RNCallKeep.addEventListener("didLoadWithEvents", (events: any) => {
      const list = Array.isArray(events) ? events : [];
      for (const evt of list) {
        const name = evt?.name;
        // A buffered activation means CallKit handed us the audio session
        // before JS booted — record it so the answer path doesn't wait.
        if (name === "RNCallKeepDidActivateAudioSession") {
          markIosAudioSessionActive(true);
          continue;
        }
        const callUUID = String(evt?.data?.callUUID || "");
        if (!callUUID) continue;
        if (name === "RNCallKeepPerformAnswerCallAction") {
          console.log("[CALLKEEP_ANSWER] replaying buffered cold-start answer, uuid=" + callUUID);
          params.onAnswer(callIdForCallKitUuid(callUUID) ?? callUUID);
        } else if (name === "RNCallKeepPerformEndCallAction") {
          console.log("[CALLKEEP_ANSWER] replaying buffered cold-start end, uuid=" + callUUID);
          params.onEnd(callIdForCallKitUuid(callUUID) ?? callUUID);
        }
      }
      // The native buffer is NOT cleared by the flush — a listener re-attach
      // (remount) would replay the same taps into the answer pipeline again.
      // Clear it once consumed; downstream accept/decline dedupe covers the
      // same-mount double-delivery case.
      if (list.length > 0) {
        try {
          (RNCallKeep as any).clearInitialEvents?.();
        } catch {
          // best-effort — dedupe keys downstream make replays harmless
        }
      }
    });
    // Track CallKit's audio-session handoff so the answer path can wait for
    // it before opening the mic (see waitForIosAudioSessionActivation above).
    audioActivateSub = RNCallKeep.addEventListener("didActivateAudioSession", () => {
      console.log("[CALLKEEP_AUDIO] didActivateAudioSession");
      markIosAudioSessionActive(true);
    });
    audioDeactivateSub = RNCallKeep.addEventListener("didDeactivateAudioSession", () => {
      console.log("[CALLKEEP_AUDIO] didDeactivateAudioSession");
      markIosAudioSessionActive(false);
    });
  }
  // Translate the CallKit UUID back to the backend callId before handing it to
  // the shared answer/decline pipeline. On Android the map is empty, so the raw
  // value (already the callId) passes straight through unchanged.
  const answerSub = RNCallKeep.addEventListener("answerCall", ({ callUUID }: any) => {
    params.onAnswer(callIdForCallKitUuid(callUUID) ?? callUUID);
  });
  const endSub = RNCallKeep.addEventListener("endCall", ({ callUUID }: any) => {
    params.onEnd(callIdForCallKitUuid(callUUID) ?? callUUID);
  });
  return () => {
    try { didLoadSub?.remove(); } catch {}
    try { audioActivateSub?.remove(); } catch {}
    try { audioDeactivateSub?.remove(); } catch {}
    try { answerSub.remove(); } catch {}
    try { endSub.remove(); } catch {}
  };
}

/**
 * Returns any CallKeep events that fired before listeners were attached.
 *
 * NOTE: react-native-callkeep's native getInitialEvents() has a bug
 * (ObjectAlreadyConsumedException — WritableNativeArray consumed twice) that
 * causes a FATAL native crash on every cold start. We do NOT call that method.
 *
 * Instead, cold-start answer handling is done entirely through:
 *   1. AsyncStorage PENDING_CALL_STORAGE_KEY  (written by backgroundCallTask)
 *   2. getPendingInvites() API call
 * Both are performed in NotificationsContext immediately after setupNativeCalling().
 * The live subscribeNativeCallActions listeners pick up any answer/end events
 * that fire after React mounts, so no pre-mount buffering is needed.
 */
export async function consumeInitialCallKeepEvents(): Promise<
  Array<{ type: "answer" | "end"; callUUID: string }>
> {
  // Intentionally returns empty — see note above.
  // Do NOT call RNCallKeep.getInitialEvents() here.
  return [];
}

/**
 * Bring the app to the foreground — useful after the user taps Answer in
 * the native CallKeep screen while the app was in the background.
 */
export function bringAppToForeground() {
  try {
    (RNCallKeep as any).backToForeground?.();
  } catch {
    // ignore
  }
}


/** End ALL CallKit calls. Clears an orphaned/leaked "active call" (the green
 *  status-bar pill) when the app returns to the foreground with no live call.
 *  Callers MUST guard behind a definitive "no live call" check. Never throws. */
export function endAllNativeCalls() {
  try {
    RNCallKeep.endAllCalls();
  } catch {
    // ignore
  }
}
