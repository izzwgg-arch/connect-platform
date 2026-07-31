/**
 * sipClientSingleton.ts
 *
 * Process-wide SIP client singleton.
 *
 * Why this exists
 * ---------------
 * The JsSIP UA (and its WebSocket + any incoming INVITE session) lives in
 * memory. Historically `SipContext` created a brand-new client on every mount
 * (`createSipClient()`), so the only place SIP could register was the React
 * tree — which is not mounted while the app is terminated/swiped.
 *
 * When a call arrives at a killed app, the headless FCM task
 * (`backgroundCallTask`) runs JS in the same process but never mounts
 * `SipContext`. By routing BOTH the headless task and `SipContext` through this
 * single shared instance, the headless task can REGISTER during the ring
 * window, the inbound INVITE lands on that live UA, and when the user answers
 * (mounting `SipContext`) the very same UA — already registered, INVITE in
 * hand — answers instantly instead of cold-registering and waiting several
 * seconds for the PBX to re-deliver the INVITE.
 *
 * Safety: `configure()` only stores the bundle (no teardown) and `register()`
 * (without forceRestart) is a no-op when already registered and refuses to tear
 * down the UA while an INVITE is in flight, so attaching from `SipContext` on
 * mount never clobbers a registration this module established during the ring.
 */
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

import { logCallFlow } from "../debug/callFlowDebug";
import { createSipClient } from "./index";
import { installInCallNotificationActions } from "./inCallNotificationActions";
import type { SipClient } from "./types";
import type { ProvisioningBundle } from "../types";

// Survives React-tree unmount (recents swipe): the notification End/Speaker/
// Mute buttons must control the call even when SipContext is gone. Installed
// at module scope so both the headless boot path and the app boot path get it.
installInCallNotificationActions();

/** Must match SipContext's PROVISION_KEY (SecureStore). */
const PROVISION_KEY = "cc_mobile_provision";

/**
 * Throttled backend device re-report for headless operation (no React tree).
 * Lazy-required so the cold index.js boot stays light; the reporter itself
 * self-throttles (~5 min) and never throws.
 */
function reportHeadlessHealth(reason: string): void {
  // ⛔ ANDROID ONLY (owner directive, Izzy 2026-07-31). This health re-report
  // belongs to the Android registration-drop work — it keeps lastSeenAt and the
  // keep-alive snapshot fresh so the server watchdog can tell a genuinely dead
  // Android device from a quiet one. iOS is reachable via APNs VoIP regardless
  // of registration, so it has no such watchdog relationship, and reporting
  // from headless iOS paths only feeds the Android-shaped keep-alive signal
  // back to a phone that must ignore it.
  if (Platform.OS !== "android") return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("../notifications/headlessDeviceReport") as typeof import("../notifications/headlessDeviceReport");
    mod.reportDeviceHealthHeadless(reason);
  } catch {
    /* best-effort only */
  }
}

let _client: SipClient | null = null;

// [RUNTIME_PROOF / Step 0] Per-JS-runtime identity for the SIP singleton. A
// second distinct sipRuntimeTag (or count>1) in one PID means the module was
// evaluated in a duplicate React runtime — the 2026-06-19 regression.
const __SIP_RUNTIME_TAG = Math.random().toString(36).slice(2, 8);
let __clientCreateCount = 0;

/**
 * The one SIP client for this JS runtime. Created lazily so the headless push
 * task and `SipContext` share the same UA regardless of which runs first.
 */
export function getSipClient(): SipClient {
  if (!_client) {
    _client = createSipClient();
    __clientCreateCount += 1;
    // eslint-disable-next-line no-console
    console.log(
      `[RUNTIME_PROOF] sipClientSingleton_created count=${__clientCreateCount} sipRuntimeTag=${__SIP_RUNTIME_TAG}`,
    );
  }
  return _client;
}

/** Non-creating peek — returns null if no client has been instantiated yet. */
export function peekSipClient(): SipClient | null {
  return _client;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Load SIP provisioning from SecureStore into the shared client. Safe to call
 * from a headless context (no React / no hooks). Idempotent — calling it again
 * just re-applies the stored bundle (which does not tear down the UA).
 *
 * On a cold wake-boot the JS runtime and its native modules (including
 * expo-secure-store) are still initializing when the wake registrar runs, so a
 * single read can transiently fail/return null before the store is ready.
 * `retries`/`backoffMs` add a bounded re-read so the prewake path does not give
 * up on provisioning that is present but momentarily unreadable. Default
 * (retries=0) preserves the original single-shot behaviour for existing callers.
 */
export async function ensureSipProvisioning(
  opts?: { retries?: number; backoffMs?: number },
): Promise<boolean> {
  const retries = Math.max(0, opts?.retries ?? 0);
  const backoffMs = Math.max(0, opts?.backoffMs ?? 300);
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const raw = await SecureStore.getItemAsync(PROVISION_KEY).catch(() => null);
      if (raw) {
        const parsed = JSON.parse(raw) as ProvisioningBundle;
        getSipClient().configure(parsed);
        return true;
      }
    } catch {
      /* transient (store not ready / parse) — fall through to retry */
    }
    if (attempt < retries) await sleep(backoffMs);
  }
  return false;
}

// Single-flight guard: the wake registrar can invoke headlessPreRegisterSip via
// BOTH the drain path and a live `Sip.WakeRegister` event for the same call.
// Collapsing concurrent callers onto one in-flight promise guarantees exactly
// ONE REGISTER attempt-chain per boot (JsSipClient.register() also dedupes, but
// this avoids even entering the register path twice).
let _preRegisterInFlight: Promise<boolean> | null = null;

/**
 * Pre-register SIP from a headless push context so the device is online during
 * the ring (before the user answers). Never force-restarts, so a healthy UA or
 * an in-flight INVITE is preserved. Returns true once registration is (or
 * already was) established.
 *
 * Hardened for the cold swiped-away boot: provisioning is read with a bounded
 * retry, and register is attempted up to MAX_ATTEMPTS with short backoff so a
 * single transient failure (WS not up yet, provisioning a beat late) does not
 * miss the PBX wake-grace window. All retries are bounded and end in a single
 * successful REGISTER (or give up) — no forceRestart, no UA teardown.
 */
export async function headlessPreRegisterSip(): Promise<boolean> {
  if (_preRegisterInFlight) return _preRegisterInFlight;
  _preRegisterInFlight = (async (): Promise<boolean> => {
    const client = getSipClient();
    try {
      if (client.isRegistered()) {
        reportHeadlessHealth("prewake_already_registered");
        return true;
      }
    } catch {
      /* fall through to (re)register */
    }

    const MAX_ATTEMPTS = 3;
    const RETRY_BACKOFF_MS = 400;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const provisioned = await ensureSipProvisioning({ retries: 4, backoffMs: 300 });
      if (!provisioned) {
        if (attempt < MAX_ATTEMPTS) {
          await sleep(RETRY_BACKOFF_MS);
          continue;
        }
        return false;
      }
      try {
        await client.register();
      } catch {
        if (attempt < MAX_ATTEMPTS) {
          await sleep(RETRY_BACKOFF_MS);
          continue;
        }
        return false;
      }
      try {
        if (client.isRegistered()) {
          reportHeadlessHealth("prewake_registered");
          return true;
        }
      } catch {
        // Cannot determine state — the register() call resolved, assume ok.
        reportHeadlessHealth("prewake_registered_assumed");
        return true;
      }
      // register() resolved but the registered event has not landed yet; wait a
      // beat and re-check on the next iteration rather than declaring failure.
      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_BACKOFF_MS);
    }
    try {
      return client.isRegistered();
    } catch {
      return false;
    }
  })();
  try {
    return await _preRegisterInFlight;
  } finally {
    _preRegisterInFlight = null;
  }
}

/**
 * Standing-registration maintenance register. Unlike headlessPreRegisterSip
 * (which no-ops when the client BELIEVES it is registered), this always puts a
 * REGISTER on the wire: in the background Android freezes JS timers, so
 * JsSIP's own refresh never runs and the client's isRegistered() belief goes
 * stale while the PBX silently expires the contact (then the initial dial of
 * an incoming call skips this phone entirely — the 2026-07-27 slow-answer
 * root cause). The forced refresh both renews the PBX binding and keeps the
 * carrier NAT mapping warm. If the refresh fails, the socket is presumed dead
 * and the UA is rebuilt via a forced register.
 */
/**
 * Max acceptable age of the last CONFIRMED register at a maintenance tick.
 * Ticks are nominally 240 s (SipKeepAliveService standing-idle heartbeat), so
 * a healthy cycle shows age ≈ 240–300 s at the next tick. If the previous
 * tick's refresh got no reply (carrier NAT silently dropped the socket) the
 * age reads ≈ 480 s+ — well past this threshold — and we rebuild. 420 s also
 * stays under the 600 s registrar expiry, so the rebuild lands before the PBX
 * drops the contact.
 */
export async function headlessMaintenanceRegisterSip(): Promise<boolean> {
  const client = getSipClient();
  let believesRegistered = false;
  try {
    believesRegistered = client.isRegistered();
  } catch { /* treat as not registered */ }

  if (believesRegistered) {
    let refreshUnanswered = false;
    try {
      refreshUnanswered = (client as any).isRefreshUnanswered?.() === true;
    } catch { /* treat as answered */ }

    if (refreshUnanswered) {
      // A previous tick's refresh went unanswered — the socket is presumed
      // silently dead (carrier NAT drop). Rebuild on a fresh UA/WebSocket.
      // NOTE: the verdict is keyed to our own unanswered refresh, NOT to
      // wall-clock registration age — the heartbeat alarm is inexact and can
      // be deferred well past its cadence (observed 2026-07-28: 240 s alarm
      // fired at 420 s), and an age check false-positived on the first
      // deferred tick, force-restarting a healthy UA and unregistering from
      // the PBX for the ~reconnect window.
      // register()'s success path resolves off socket events, which DO run in
      // the background; only its failure watchdogs need timers, and a hung
      // attempt is detected and rebuilt by the next tick's register() call
      // (REGISTER_ATTEMPT_STUCK_MS). Maintenance ticks are never dispatched
      // while a call is active, so the teardown is safe.
      logCallFlow('SIP_MAINT_SOCKET_STALE', {
        inviteId: null,
        extra: { registerAgeMs: client.getRegistrationAgeMs?.() ?? null, refreshUnanswered: true },
      });
      try {
        await client.register({ forceRestart: true });
        return client.isRegistered();
      } catch {
        return false;
      }
    }

    // Healthy socket: put a refresh REGISTER on the wire and get out. NO
    // awaiting a reply — JS timers are frozen in the background, so any
    // timeout-based wait would hang until the app is foregrounded. The reply
    // (a socket event, which does fire in background) updates registeredAtMs;
    // the next tick's staleness check above is the failure detector.
    try {
      const refreshed = (client as any).sendRegisterRefresh?.() === true;
      // Keep the backend's device view fresh while running headless — the
      // NotificationsContext 60 s heartbeat only exists with a mounted UI
      // (self-throttled to ~5 min inside the reporter).
      if (refreshed) reportHeadlessHealth("maintenance_refresh");
      return refreshed;
    } catch {
      return false;
    }
  }

  // Not registered at all — the standard bounded pre-register path already
  // handles provisioning reads and retries.
  return headlessPreRegisterSip();
}

/** Best-effort check used by the headless hold loop. */
export function isSipRegistered(): boolean {
  if (!_client) return false;
  try {
    return _client.isRegistered();
  } catch {
    return false;
  }
}

/** True if the shared client currently owns at least one live session. */
export function hasActiveSipSession(): boolean {
  if (!_client) return false;
  try {
    return _client.hasActiveSession();
  } catch {
    return false;
  }
}
