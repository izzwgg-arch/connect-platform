/**
 * sipWakeRegistrar.ts
 *
 * Module-scope (NON-React-tree) SIP wake registrar — Phase 2/Layer 2 consumer.
 *
 * Why this exists
 * ---------------
 * When the app is swiped away / killed, an INCOMING_CALL_WAKE FCM push boots
 * the app's EXISTING singleton React runtime (see
 * IncomingCallFirebaseService.ensureReactRuntimeForWake). But a bare runtime
 * boot runs `index.js` and initializes native modules WITHOUT mounting the
 * React component tree — so `SipContext` (which normally handles
 * `Sip.WakeRegister`) is NOT mounted and cannot register.
 *
 * This registrar runs at module scope (imported from `index.js` before
 * `registerRootComponent`), so it is present the moment the runtime boots,
 * independent of the React tree. It registers SIP through the SAME
 * process-wide `sipClientSingleton.getSipClient()` that `SipContext` uses, so
 * when the user later answers and `SipContext` mounts, it attaches to the
 * already-registered client — one runtime, one client, one UA.
 *
 * Delivery paths (exactly one wins per call, deduped by pbxCallId):
 *   • drain  — on attach we pull any wake the native layer buffered before JS
 *              existed (the cold/killed boot case), via
 *              NativeModules.IncomingCallUi.drainPendingWake().
 *   • event  — a `Sip.WakeRegister` DeviceEventEmitter push that lands while we
 *              are already attached (warm/live case, or a wake after boot).
 *
 * Duplicate safety:
 *   • Per-pbxCallId 30 s suppression here.
 *   • The real cross-caller guard is `JsSipClient.register()`'s single
 *     `registerPromise` — concurrent callers (this registrar + a mounted
 *     SipContext) collapse into ONE REGISTER; `headlessPreRegisterSip()`
 *     no-ops when already registered and never tears down a live UA.
 */
import { DeviceEventEmitter, NativeModules, Platform } from "react-native";

import { logCallFlow } from "../debug/callFlowDebug";

const WAKE_EVENT = "Sip.WakeRegister";
const DEDUP_WINDOW_MS = 30_000;

let started = false;
// Only a CONFIRMED successful registration marks a call as handled. A failed
// attempt must NOT poison the dedup window, otherwise the second delivery path
// (drain vs event) — the one that could still succeed — would be suppressed and
// the cold call would miss the PBX wake-grace window.
let lastHandled: { pbxCallId: string; ts: number } | null = null;
let inFlightPbxCallId: string | null = null;

async function handleWake(raw: unknown, source: "drain" | "event"): Promise<void> {
  const payload = (raw ?? {}) as Record<string, unknown>;
  const pbxCallId = String(payload.pbxCallId ?? "").trim();
  if (!pbxCallId) {
    return;
  }

  const now = Date.now();
  if (
    lastHandled &&
    lastHandled.pbxCallId === pbxCallId &&
    now - lastHandled.ts < DEDUP_WINDOW_MS
  ) {
    logCallFlow("WAKE_REGISTRAR_DUPLICATE", { pbxCallId, extra: { source, reason: "already_registered" } });
    return;
  }
  if (inFlightPbxCallId === pbxCallId) {
    // The other delivery path is mid-register for this same call; the shared
    // single-flight in sipClientSingleton will register once — don't re-enter.
    logCallFlow("WAKE_REGISTRAR_DUPLICATE", { pbxCallId, extra: { source, reason: "in_flight" } });
    return;
  }
  inFlightPbxCallId = pbxCallId;

  logCallFlow("WAKE_REGISTRAR_HANDLE", {
    pbxCallId,
    extra: { source, appState: String(payload.appState ?? "") },
  });

  try {
    // Lazy-require so the heavy SIP/WebRTC module graph is only pulled in when a
    // wake actually arrives (keeps the cold index.js load light).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const singleton = require("../sip/sipClientSingleton") as typeof import("../sip/sipClientSingleton");
    const registered = await singleton.headlessPreRegisterSip();
    // Record dedup ONLY on success so a failed path can still be retried by the
    // other delivery path (or a re-emitted wake).
    if (registered) {
      lastHandled = { pbxCallId, ts: Date.now() };
    }
    logCallFlow("WAKE_REGISTRAR_RESULT", { pbxCallId, extra: { source, registered } });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    logCallFlow("WAKE_REGISTRAR_ERROR", { pbxCallId, extra: { source, message } });
  } finally {
    if (inFlightPbxCallId === pbxCallId) inFlightPbxCallId = null;
  }
}

/**
 * Attach the module-scope wake listener + drain any buffered wake. Idempotent.
 */
export function startSipWakeRegistrar(): void {
  if (started) {
    return;
  }
  if (Platform.OS !== "android") {
    return;
  }
  started = true;

  // Live-push path: subscribe FIRST so a wake emitted right after boot is not
  // missed while we drain the buffer below.
  DeviceEventEmitter.addListener(WAKE_EVENT, (raw: unknown) => {
    void handleWake(raw, "event");
  });

  // Buffered path: pull anything the native layer stored before this runtime
  // existed (the cold/killed boot case). Cleared on the native side when
  // consumed, so this can only deliver once.
  try {
    const mod = NativeModules.IncomingCallUi as
      | { drainPendingWake?: () => Promise<unknown> }
      | undefined;
    if (mod?.drainPendingWake) {
      mod
        .drainPendingWake()
        .then((raw) => {
          if (raw) {
            void handleWake(raw, "drain");
          }
        })
        .catch(() => undefined);
    }
  } catch {
    /* native module not available (e.g. iOS / bridge not ready) — ignore */
  }
}

startSipWakeRegistrar();
