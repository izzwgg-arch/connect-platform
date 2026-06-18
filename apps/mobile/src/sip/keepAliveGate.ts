import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Adaptive keep-alive activation gate.
 *
 * Why this exists
 * ---------------
 * The background SIP keep-alive foreground service (SipKeepAliveService) keeps
 * a persistent notification + partial wake lock so the JsSIP WebSocket survives
 * while the app is backgrounded. That is exactly what an aggressive-OEM device
 * (e.g. Galaxy S25 / new One UI) needs — but it is pure cost (a permanent
 * notification + battery) on a phone that already delivers calls fine in the
 * background via the FCM wake-push path (e.g. an S24 on older One UI, a Pixel).
 *
 * So we do NOT run the FGS on every device. The gate starts OFF everywhere and
 * latches ON only after the app observes, at runtime, that THIS device failed
 * to deliver / hold its SIP registration in the background when it actually
 * mattered (an incoming call). A healthy phone whose FCM wake succeeds quickly
 * never trips a trigger and therefore never shows the notification.
 *
 * The decision is sticky and persisted: once a device proves it needs keep-alive
 * we keep it on across launches (process death included), so the user only ever
 * risks ONE slow/dropped background call before protection turns on.
 *
 * This module persists only a tiny JSON blob and has no native/UI coupling, so
 * it is safe to call from anywhere in the JS layer (including a cold FCM-wake
 * process).
 */

const GATE_KEY = "cc.keepalive.gate.v1";

export type KeepAliveGateState = {
  version: 1;
  /** Latched decision: has this device proven it needs the keep-alive FGS? */
  needed: boolean;
  /** Why it latched (first qualifying trigger). */
  reason: string;
  /** Wall-clock ms at which `needed` flipped true. 0 = never. */
  latchedAtMs: number;
  /** How many qualifying background-delivery failures we have observed. */
  dropCount: number;
  /** Last time the app went to background while wanting registration. */
  lastBackgroundAtMs: number;
};

const DEFAULT_STATE: KeepAliveGateState = {
  version: 1,
  needed: false,
  reason: "",
  latchedAtMs: 0,
  dropCount: 0,
  lastBackgroundAtMs: 0,
};

/**
 * One confirmed background-delivery failure is enough to activate. The user
 * explicitly accepted that the very first drop may slip through before the FGS
 * turns on — so we do not wait for a second strike.
 */
export const KEEPALIVE_DROP_THRESHOLD = 1;

/**
 * A wake-register that takes longer than this to land registration means the
 * caller most likely gave up (PSTN/SIP callers abandon ~10-15s). We treat that
 * as a delivery failure even though the register technically succeeded, because
 * from the user's perspective the call did not arrive in time.
 */
export const SLOW_WAKE_MS = 8_000;

let cache: KeepAliveGateState | null = null;

export async function loadKeepAliveGate(): Promise<KeepAliveGateState> {
  if (cache) return cache;
  try {
    const raw = await AsyncStorage.getItem(GATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<KeepAliveGateState>;
      cache = { ...DEFAULT_STATE, ...parsed, version: 1 };
      return cache;
    }
  } catch {
    /* fall through to default */
  }
  cache = { ...DEFAULT_STATE };
  return cache;
}

/** Synchronous best-effort read of the last loaded state (may be stale/default). */
export function getKeepAliveGateCached(): KeepAliveGateState {
  return cache ?? { ...DEFAULT_STATE };
}

async function persist(next: KeepAliveGateState): Promise<void> {
  cache = next;
  try {
    await AsyncStorage.setItem(GATE_KEY, JSON.stringify(next));
  } catch {
    /* ignore persistence failures — cache still holds the value this session */
  }
}

export async function recordBackgroundTimestamp(atMs: number): Promise<void> {
  const cur = await loadKeepAliveGate();
  if (cur.lastBackgroundAtMs === atMs) return;
  await persist({ ...cur, lastBackgroundAtMs: atMs });
}

/**
 * Record a confirmed "this device did not deliver / hold its registration in the
 * background" event and return the updated state. Latches `needed=true` once the
 * drop count reaches the threshold. If already latched, just bumps the count and
 * preserves the original reason/timestamp.
 */
export async function recordBackgroundDrop(reason: string): Promise<KeepAliveGateState> {
  const cur = await loadKeepAliveGate();
  const dropCount = cur.dropCount + 1;
  const latchNow = !cur.needed && dropCount >= KEEPALIVE_DROP_THRESHOLD;
  const next: KeepAliveGateState = {
    ...cur,
    dropCount,
    needed: cur.needed || latchNow,
    reason: cur.needed ? cur.reason : latchNow ? reason : cur.reason,
    latchedAtMs: cur.needed ? cur.latchedAtMs : latchNow ? Date.now() : cur.latchedAtMs,
  };
  await persist(next);
  return next;
}

/**
 * Force the gate on (e.g. an automatic server-side observation that this device
 * went Unreachable while it was an active endpoint). Idempotent. Kept separate
 * from `recordBackgroundDrop` so the latch reason is explicit.
 */
export async function forceKeepAliveNeeded(reason: string): Promise<KeepAliveGateState> {
  const cur = await loadKeepAliveGate();
  if (cur.needed) return cur;
  const next: KeepAliveGateState = {
    ...cur,
    needed: true,
    reason,
    latchedAtMs: Date.now(),
    dropCount: Math.max(cur.dropCount, KEEPALIVE_DROP_THRESHOLD),
  };
  await persist(next);
  return next;
}

/** Clear the latch (diagnostics / support tooling). */
export async function resetKeepAliveGate(): Promise<void> {
  await persist({ ...DEFAULT_STATE });
}
