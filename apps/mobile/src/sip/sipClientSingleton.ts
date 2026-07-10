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
import * as SecureStore from "expo-secure-store";

import { createSipClient } from "./index";
import type { SipClient } from "./types";
import type { ProvisioningBundle } from "../types";

/** Must match SipContext's PROVISION_KEY (SecureStore). */
const PROVISION_KEY = "cc_mobile_provision";

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
      if (client.isRegistered()) return true;
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
        if (client.isRegistered()) return true;
      } catch {
        // Cannot determine state — the register() call resolved, assume ok.
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
