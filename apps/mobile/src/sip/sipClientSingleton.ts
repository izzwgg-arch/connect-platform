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

/**
 * The one SIP client for this JS runtime. Created lazily so the headless push
 * task and `SipContext` share the same UA regardless of which runs first.
 */
export function getSipClient(): SipClient {
  if (!_client) {
    _client = createSipClient();
  }
  return _client;
}

/** Non-creating peek — returns null if no client has been instantiated yet. */
export function peekSipClient(): SipClient | null {
  return _client;
}

/**
 * Load SIP provisioning from SecureStore into the shared client. Safe to call
 * from a headless context (no React / no hooks). Idempotent — calling it again
 * just re-applies the stored bundle (which does not tear down the UA).
 */
export async function ensureSipProvisioning(): Promise<boolean> {
  try {
    const raw = await SecureStore.getItemAsync(PROVISION_KEY).catch(() => null);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as ProvisioningBundle;
    getSipClient().configure(parsed);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pre-register SIP from a headless push context so the device is online during
 * the ring (before the user answers). Never force-restarts, so a healthy UA or
 * an in-flight INVITE is preserved. Returns true once registration is (or
 * already was) established.
 */
export async function headlessPreRegisterSip(): Promise<boolean> {
  const client = getSipClient();
  try {
    if (client.isRegistered()) return true;
  } catch {
    /* fall through to (re)register */
  }
  const provisioned = await ensureSipProvisioning();
  if (!provisioned) return false;
  try {
    await client.register();
  } catch {
    return false;
  }
  try {
    return client.isRegistered();
  } catch {
    return true;
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
