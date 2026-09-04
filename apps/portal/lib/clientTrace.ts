/**
 * Client trace — the softphone writes down what it did, so support can read it
 * from the database instead of a customer's screen.
 *
 * ⛔ WHY (2026-09-03): "caller hears me, I don't hear the caller" on headsets
 * was undiagnosable without remote-controlling the customer's computer, because
 * nothing recorded which mic/speaker the app picked, whether the pick actually
 * applied (`setSinkId` failures were a console warn), what device the call
 * really used, or what the person pressed. Every one of those is a `trace()`
 * call now, landing as CLIENT_TRACE rows on /admin/call-timeline.
 *
 * ⛔⛔ THE RULES THAT KEEP THIS FROM BECOMING THE NEXT FLOOD:
 *  - Never one request per event. Events queue in a ring buffer and go out in
 *    batches (≤ 50) on a debounce, with a hard ceiling on how long anything
 *    waits. The voicemail-preload flood (2026-08-17) and the softphone's own
 *    self-lockout (2026-08-10) were both "one request per tick" bugs.
 *  - Never while signed out — a public page must never emit a 401.
 *  - Never throw. Losing a trace must never cost a call or a click.
 *  - Never record what was typed or dialled: DTMF is a COUNT, a dial target is
 *    a digit count. The CDR already holds the number; this holds behaviour.
 *  - Device ids are shortened (they are per-origin opaque hashes anyway);
 *    device LABELS are kept in full — the label IS the diagnosis.
 */
import { apiPost, getPortalApiBaseUrl, hasBrowserAuthToken, peekBrowserAuthToken } from "../services/apiClient";
import { ensureVoiceDiagSession } from "./voiceDiagSession";

export type TraceKind =
  | "device_inventory"
  | "mic_auto_picked"
  | "mic_selected"
  | "mic_select_failed"
  | "speaker_selected"
  | "speaker_select_failed"
  | "speaker_toggle"
  | "ringer_selected"
  | "mic_opened"
  | "mic_open_failed"
  | "remote_audio_attached"
  | "remote_audio_play_blocked"
  | "one_way_audio"
  | "incoming_audio_resumed"
  | "remote_track_muted"
  | "remote_track_unmuted"
  | "remote_track_ended"
  | "call_end"
  | "media_sample"
  | "reg_state"
  | "press"
  | "settings_opened"
  | "shell_info"
  | "shell_log";

export interface TraceEvent {
  at: string;
  kind: TraceKind;
  facts: Record<string, unknown>;
}

/** Buffer cap — older events are dropped first; a burst can never grow memory. */
export const TRACE_BUFFER_CAP = 300;
/** Per-POST cap; must not exceed the api's MAX_EVENTS_PER_BATCH (50). */
export const TRACE_BATCH_SIZE = 50;
/** Quiet-period debounce before a batch goes out. */
export const TRACE_DEBOUNCE_MS = 2_500;
/** Nothing waits longer than this, however busy the client is. */
export const TRACE_MAX_WAIT_MS = 10_000;

type Transport = (sessionId: string, events: TraceEvent[], keepalive: boolean) => Promise<void>;

const defaultTransport: Transport = async (sessionId, events, keepalive) => {
  if (!keepalive) {
    await apiPost("/voice/diag/events", { sessionId, events });
    return;
  }
  // pagehide: the ordinary client would be torn down with the page. A keepalive
  // fetch survives navigation/close; it needs the bearer by hand.
  const token = peekBrowserAuthToken();
  if (!token) return;
  await fetch(`${getPortalApiBaseUrl()}/voice/diag/events`, {
    method: "POST",
    keepalive: true,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ sessionId, events }),
  });
};

const state = {
  buffer: [] as TraceEvent[],
  debounceTimer: null as ReturnType<typeof setTimeout> | null,
  firstQueuedAt: null as number | null,
  flushing: false,
  transport: defaultTransport as Transport,
  lastInventorySignature: "" as string,
  installed: false,
};

/** First 8 chars of an opaque deviceId — enough to tell two devices apart, no secret in it. */
export function shortDeviceId(id: string | null | undefined): string {
  const s = String(id ?? "");
  if (!s) return "";
  if (s === "default" || s === "communications") return s;
  return s.slice(0, 8);
}

/** The label for a deviceId out of an enumerateDevices list; falls back to a stable placeholder. */
export function labelFor(devices: ReadonlyArray<{ deviceId: string; label: string }>, id: string | null | undefined): string {
  const s = String(id ?? "");
  if (!s) return "System default";
  const d = devices.find((x) => x.deviceId === s);
  if (d?.label) return d.label;
  if (s === "default") return "System default";
  if (s === "communications") return "Default communications device";
  return `(unnamed ${shortDeviceId(s)})`;
}

/**
 * A compact, LABEL-carrying snapshot of the device list. Labels are only
 * populated once the mic permission has been granted; before that Chrome hands
 * back empty strings, which is itself a fact worth seeing on the timeline.
 */
export function summarizeDevices(devices: ReadonlyArray<{ deviceId: string; kind: string; label: string }>) {
  const pick = (kind: string) =>
    devices
      .filter((d) => d.kind === kind)
      .slice(0, 20)
      .map((d) => ({ id: shortDeviceId(d.deviceId), label: d.label || "" }));
  return { inputs: pick("audioinput"), outputs: pick("audiooutput") };
}

/** Stable signature so an identical inventory (Bluetooth flap that changed nothing) is not re-sent. */
export function inventorySignature(summary: { inputs: Array<{ id: string; label: string }>; outputs: Array<{ id: string; label: string }> }): string {
  return JSON.stringify([summary.inputs.map((d) => d.id + ":" + d.label), summary.outputs.map((d) => d.id + ":" + d.label)]);
}

function schedule(): void {
  const now = Date.now();
  if (state.firstQueuedAt === null) state.firstQueuedAt = now;
  const waited = now - state.firstQueuedAt;
  const delay = Math.max(0, Math.min(TRACE_DEBOUNCE_MS, TRACE_MAX_WAIT_MS - waited));
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => {
    state.debounceTimer = null;
    void flushClientTrace();
  }, delay);
}

/**
 * Record one fact. Synchronous, never throws, never awaits. `flush: true` sends
 * the batch as soon as this event is queued (used for call_end, where the
 * next thing the person does is often close the window).
 */
export function trace(kind: TraceKind, facts: Record<string, unknown> = {}, opts: { flush?: boolean } = {}): void {
  try {
    if (typeof window === "undefined") return;
    if (kind === "device_inventory") {
      const sig = inventorySignature(facts as ReturnType<typeof summarizeDevices>);
      if (sig === state.lastInventorySignature) return;
      state.lastInventorySignature = sig;
    }
    state.buffer.push({ at: new Date().toISOString(), kind, facts });
    if (state.buffer.length > TRACE_BUFFER_CAP) state.buffer.splice(0, state.buffer.length - TRACE_BUFFER_CAP);
    installLifecycleHooks();
    if (opts.flush) void flushClientTrace();
    else schedule();
  } catch {
    /* a trace must never cost a call */
  }
}

/**
 * Send whatever is queued. Safe to call any time; concurrent calls coalesce.
 * With no session (signed out, or the api unreachable) the buffer is kept —
 * bounded by TRACE_BUFFER_CAP — for the next attempt.
 */
export async function flushClientTrace(opts: { keepalive?: boolean } = {}): Promise<void> {
  if (state.flushing || state.buffer.length === 0) return;
  if (!hasBrowserAuthToken()) return;
  state.flushing = true;
  try {
    const sessionId = await ensureVoiceDiagSession();
    if (!sessionId) return;
    // Drain in ≤ TRACE_BATCH_SIZE chunks; on a failed send, put the chunk back
    // and stop — the api may be rate limiting us, and hammering it is the bug
    // this module exists to avoid.
    while (state.buffer.length > 0) {
      const chunk = state.buffer.splice(0, TRACE_BATCH_SIZE);
      try {
        await state.transport(sessionId, chunk, !!opts.keepalive);
      } catch {
        state.buffer.unshift(...chunk);
        if (state.buffer.length > TRACE_BUFFER_CAP) state.buffer.splice(0, state.buffer.length - TRACE_BUFFER_CAP);
        break;
      }
      if (opts.keepalive) break; // one keepalive request on the way out is all the browser allows
    }
  } catch {
    /* swallow — see header */
  } finally {
    state.flushing = false;
    if (state.buffer.length === 0) state.firstQueuedAt = null;
    else if (!state.debounceTimer && !opts.keepalive) {
      // Something was put back: try again later, never in a tight loop.
      state.firstQueuedAt = Date.now();
      state.debounceTimer = setTimeout(() => {
        state.debounceTimer = null;
        void flushClientTrace();
      }, TRACE_MAX_WAIT_MS);
    }
  }
}

function installLifecycleHooks(): void {
  if (state.installed || typeof window === "undefined") return;
  state.installed = true;
  const onHide = () => {
    if (document.visibilityState === "hidden") void flushClientTrace({ keepalive: true });
  };
  document.addEventListener("visibilitychange", onHide);
  window.addEventListener("pagehide", () => void flushClientTrace({ keepalive: true }));
}

/** Test seams — never used by product code. */
export const __clientTraceTestSeams = {
  setTransport(t: Transport | null) {
    state.transport = t ?? defaultTransport;
  },
  reset() {
    state.buffer = [];
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = null;
    state.firstQueuedAt = null;
    state.flushing = false;
    state.lastInventorySignature = "";
  },
  buffered(): number {
    return state.buffer.length;
  },
};
