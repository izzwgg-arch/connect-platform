/**
 * callLatency.ts — millisecond-precision instrumentation of the inbound
 * call-answer pipeline.
 *
 * Emits two kinds of lines, both greppable from logcat:
 *
 *   1. Per-event compact line (every `mark` call):
 *        [CALL_LATENCY] event=ANSWER_TAPPED +120ms total=850ms id=cmo6... ctx={...}
 *
 *   2. Final timeline summary on call-active or call-end:
 *        [CALL_LATENCY] --- TIMELINE id=cmo6... ---
 *          INCOMING_RECEIVED           +0ms     total=0ms
 *          INCOMING_UI_SHOWN           +35ms    total=35ms
 *          ANSWER_TAPPED               +2800ms  total=2835ms
 *          …
 *        ANSWER → AUDIO: 1050ms
 *        BOTTLENECK: ICE_CONNECTED (+390ms) [PROBLEM]
 *        SEVERITY: CRITICAL (target <200ms, got 1050ms)
 *        CTX: app=foreground pcPreWarmed=false turn=false network=wifi
 *
 * Design notes:
 *   • Single authoritative clock: `Date.now()`. Same value space used by
 *     every existing breadcrumb (native JSON `System.currentTimeMillis()`
 *     and JS `CallFlightRecorder` `tsMs`), so cross-process timings line
 *     up without translation.
 *   • Multi-id indexing: a single timeline is addressable by any of its
 *     ids (inviteId, sipSessionId, pbxCallId). `linkIds(a, b)` merges
 *     indexes so a later `mark(sessionId, …)` still finds the timeline
 *     started under `inviteId`.
 *   • Cheap when disabled: the exported `mark()` exits on the first line
 *     when the feature flag is off — zero allocation.
 *   • No side effects: this module never touches the SIP stack, audio,
 *     network, or UI. Pure observational.
 */

// ──────────────────────────────────────────────────────────────────────
// Feature flag

/**
 * Enable the detailed latency instrumentation. ON in development, plus
 * whenever the build-time env `EXPO_PUBLIC_ENABLE_CALL_LATENCY_DEBUG`
 * is `"true"`, or when JS runtime sets `globalThis.__CALL_LATENCY_DEBUG__`.
 *
 * We also auto-enable on `__DEV__` so Metro-attached builds always get the
 * timeline. Release APKs stay quiet unless the env flag or global is set.
 */
export function isCallLatencyEnabled(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g: any = globalThis as any;
    if (g.__CALL_LATENCY_DEBUG__ === true) return true;
    if (g.__CALL_LATENCY_DEBUG__ === false) return false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dev: any = (typeof __DEV__ !== "undefined" ? __DEV__ : false) as any;
    if (dev) return true;
    const flag =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((process as any)?.env?.EXPO_PUBLIC_ENABLE_CALL_LATENCY_DEBUG ||
        "") as string;
    if (flag === "true" || flag === "1") return true;
    // Release measurement mode: flip this constant to true, rebuild, run
    // the measurement campaign, flip back to false before shipping. Kept
    // as a single-line constant so a grep for `FORCE_ENABLE_IN_RELEASE`
    // shows where to turn it off.
    const FORCE_ENABLE_IN_RELEASE = true;
    if (FORCE_ENABLE_IN_RELEASE) return true;
    return false;
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Output sink — route every emitted line through both console.log (for
// dev-server debugging) and the native Android Log bridge (so it is
// visible under `adb logcat` in release builds where Hermes does not
// pipe console.log to android.util.Log).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let nativeLoggerResolved: any = undefined;
function getNativeLogger(): ((line: string) => void) | null {
  if (nativeLoggerResolved !== undefined) return nativeLoggerResolved;
  try {
    // Lazy require so this module remains safe to import on platforms
    // (tests, web) that do not ship NativeModules.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const RN = require("react-native");
    const mod = RN?.NativeModules?.IncomingCallUi;
    if (mod && typeof mod.logLatency === "function") {
      nativeLoggerResolved = (line: string) => {
        try {
          mod.logLatency(line);
        } catch {
          // swallow — never crash instrumentation
        }
      };
    } else {
      nativeLoggerResolved = null;
    }
  } catch {
    nativeLoggerResolved = null;
  }
  return nativeLoggerResolved;
}

function emit(line: string): void {
  // Prefer native path — guaranteed to reach logcat in release.
  const native = getNativeLogger();
  if (native) native(line);
  // Always also console.log for Metro / dev builds.
  // eslint-disable-next-line no-console
  console.log(line);
}

// ──────────────────────────────────────────────────────────────────────
// Event names — STEP 2 of the instrumentation spec. The order here is
// the order we expect them to fire during a healthy inbound answer.

export type CallLatencyEvent =
  // Incoming side
  | "INCOMING_RECEIVED"
  | "INCOMING_UI_SHOWN"
  | "ANSWER_TAPPED"
  // Signaling / session setup
  | "NATIVE_ANSWER_TRIGGERED"
  | "SESSION_ACCEPT_START"
  // Fine-grained split of SESSION_ACCEPT_START → MEDIA_SETUP_START (the 694 ms
  // post-Optim-#1 black box). These mark sub-phases inside jssip.answerIncoming:
  //   • SIP_INVITE_FOUND       — polling loop found a usable SIP session
  //   • SIP_ANSWER_INVOKED     — about to call session.answer() (JsSIP internal work begins)
  //   • SIP_ANSWER_RETURNED    — session.answer() returned synchronously (PC created)
  // Gaps (FOUND→INVOKED) are pure JS glue; (INVOKED→RETURNED) is native PC construction.
  // If SESSION_ACCEPT_START→SIP_INVITE_FOUND is large, the bottleneck is PBX delivery
  // of the INVITE after re-register (fix = persistent registration / skip forceRestart).
  // If SIP_ANSWER_INVOKED→MEDIA_SETUP_START is large, bottleneck is getUserMedia / PC
  // setup (fix = peer-connection prewarm / getUserMedia prewarm).
  | "SIP_INVITE_FOUND"
  | "SIP_ANSWER_INVOKED"
  | "SIP_ANSWER_RETURNED"
  | "SESSION_ACCEPT_SIGNAL_SENT"
  | "SESSION_ESTABLISHED_SIGNAL"
  // Media
  | "MEDIA_SETUP_START"
  | "ICE_GATHERING_START"
  | "ICE_CONNECTED"
  | "ICE_COMPLETED"
  | "FIRST_AUDIO_PACKET"
  | "AUDIO_OUTPUT_STARTED"
  // Final
  | "CALL_ACTIVE_UI"
  // Terminal — for post-mortem of calls that never made it to active
  | "CALL_FAILED"
  | "CALL_ENDED";

/**
 * Ordered list used for "which event hasn't fired yet?" gap analysis and
 * when printing the timeline (we preserve first-seen order in practice,
 * but this is the canonical ordering).
 */
const EVENT_ORDER: readonly CallLatencyEvent[] = [
  "INCOMING_RECEIVED",
  "INCOMING_UI_SHOWN",
  "ANSWER_TAPPED",
  "NATIVE_ANSWER_TRIGGERED",
  "SESSION_ACCEPT_START",
  "SIP_INVITE_FOUND",
  "SIP_ANSWER_INVOKED",
  "SIP_ANSWER_RETURNED",
  "SESSION_ACCEPT_SIGNAL_SENT",
  "SESSION_ESTABLISHED_SIGNAL",
  "MEDIA_SETUP_START",
  "ICE_GATHERING_START",
  "ICE_CONNECTED",
  "ICE_COMPLETED",
  "FIRST_AUDIO_PACKET",
  "AUDIO_OUTPUT_STARTED",
  "CALL_ACTIVE_UI",
];

// ──────────────────────────────────────────────────────────────────────
// Internal store

type TimelineEntry = {
  event: CallLatencyEvent;
  tsMs: number;
  // Delta from previous entry (ms). The first entry is 0.
  delta: number;
  // Elapsed from timeline start (ms).
  total: number;
  ctx?: Record<string, unknown>;
};

type Timeline = {
  // Primary display id — the first id used when mark() opened the timeline.
  primaryId: string;
  startedAt: number;
  entries: TimelineEntry[];
  // Seen-event set so we can short-circuit duplicates if desired. We
  // allow the same event to be logged multiple times (e.g. repeated
  // SESSION_ACCEPT_START on retries) but only flag the first one in
  // the summary diff ordering.
  firstSeen: Map<CallLatencyEvent, number>;
  // Arbitrary metadata that gets printed in the CTX block.
  context: Record<string, unknown>;
  // Has the summary been emitted? Prevents double-print.
  summarized: boolean;
};

// Map from any known id → shared Timeline instance.
const timelinesByAnyId: Map<string, Timeline> = new Map();

// Cap the number of simultaneously tracked timelines so a leak (e.g.
// missing `reset`) cannot exhaust memory.
const MAX_TIMELINES = 16;
const activeTimelines: Set<Timeline> = new Set();

function pruneOldestIfNeeded() {
  if (activeTimelines.size <= MAX_TIMELINES) return;
  // Prune the oldest by startedAt.
  let oldest: Timeline | null = null;
  activeTimelines.forEach((t) => {
    if (!oldest || t.startedAt < oldest.startedAt) oldest = t;
  });
  if (oldest) {
    dropTimeline(oldest);
  }
}

function dropTimeline(t: Timeline) {
  activeTimelines.delete(t);
  for (const [k, v] of timelinesByAnyId.entries()) {
    if (v === t) timelinesByAnyId.delete(k);
  }
}

function getOrCreateTimeline(id: string): Timeline {
  const existing = timelinesByAnyId.get(id);
  if (existing) return existing;
  const t: Timeline = {
    primaryId: id,
    startedAt: Date.now(),
    entries: [],
    firstSeen: new Map(),
    context: {},
    summarized: false,
  };
  timelinesByAnyId.set(id, t);
  activeTimelines.add(t);
  pruneOldestIfNeeded();
  return t;
}

// ──────────────────────────────────────────────────────────────────────
// Public API

/**
 * Record a single event on the call's latency timeline.
 *
 * @param id    any stable call identifier (inviteId, sessionId, pbxCallId)
 * @param event one of the CallLatencyEvent names
 * @param ctx   optional extra fields to attach (flattened into the log line)
 */
export function markCallLatency(
  id: string | null | undefined,
  event: CallLatencyEvent,
  ctx?: Record<string, unknown>,
): void {
  if (!isCallLatencyEnabled()) return;
  if (!id) return;
  const t = getOrCreateTimeline(id);
  const now = Date.now();
  const prev = t.entries[t.entries.length - 1];
  const delta = prev ? now - prev.tsMs : 0;
  const total = now - t.startedAt;
  const entry: TimelineEntry = { event, tsMs: now, delta, total, ctx };
  t.entries.push(entry);
  if (!t.firstSeen.has(event)) t.firstSeen.set(event, now);
  if (ctx) Object.assign(t.context, ctx);
  const ctxSuffix = ctx ? " ctx=" + safeJson(ctx) : "";
  emit(
    `[CALL_LATENCY] event=${event} +${delta}ms total=${total}ms id=${t.primaryId}${ctxSuffix}`,
  );
}

/**
 * Merge two ids so they point at the same timeline. Both calls
 * `mark("inviteA", ...)` and `mark("sessionX", ...)` will then append to
 * the same underlying object.
 *
 * The timeline is keyed by whichever id opened it first; the other id
 * becomes an additional index onto the same instance. No data is lost.
 */
export function linkCallLatencyIds(a: string | null | undefined, b: string | null | undefined): void {
  if (!isCallLatencyEnabled()) return;
  if (!a || !b || a === b) return;
  const ta = timelinesByAnyId.get(a);
  const tb = timelinesByAnyId.get(b);
  if (ta && tb && ta !== tb) {
    // Merge tb into ta, keeping ta as the survivor.
    tb.entries.forEach((e) => {
      ta.entries.push(e);
      if (!ta.firstSeen.has(e.event)) ta.firstSeen.set(e.event, e.tsMs);
    });
    // Keep the earliest startedAt so deltas stay monotonic.
    ta.startedAt = Math.min(ta.startedAt, tb.startedAt);
    // Re-sort by tsMs for clean output.
    ta.entries.sort((x, y) => x.tsMs - y.tsMs);
    // Recompute deltas.
    let prev = ta.startedAt;
    ta.entries.forEach((e) => {
      e.delta = e.tsMs - prev;
      e.total = e.tsMs - ta.startedAt;
      prev = e.tsMs;
    });
    Object.assign(ta.context, tb.context);
    // Repoint every id that pointed at tb.
    for (const [k, v] of timelinesByAnyId.entries()) {
      if (v === tb) timelinesByAnyId.set(k, ta);
    }
    activeTimelines.delete(tb);
  } else if (ta && !tb) {
    timelinesByAnyId.set(b, ta);
  } else if (tb && !ta) {
    timelinesByAnyId.set(a, tb);
  } else {
    // Neither exists yet — open a new one under `a` so the first mark
    // under either id finds the same object.
    const t = getOrCreateTimeline(a);
    timelinesByAnyId.set(b, t);
  }
}

/**
 * Attach extra metadata to the active timeline (printed in the CTX
 * block of the summary). Merges with any existing context.
 */
export function setCallLatencyContext(
  id: string | null | undefined,
  ctx: Record<string, unknown>,
): void {
  if (!isCallLatencyEnabled()) return;
  if (!id) return;
  const t = timelinesByAnyId.get(id);
  if (!t) return;
  Object.assign(t.context, ctx);
}

/**
 * Emit the final timeline summary. Safe to call multiple times — only
 * the first call prints (and only if the timeline has ≥2 entries).
 *
 * @param id    any id for the timeline (same semantics as mark)
 * @param reason one of "active" | "ended" | "failed" — used in the header
 */
export function summarizeCallLatency(
  id: string | null | undefined,
  reason: "active" | "ended" | "failed" = "active",
): void {
  if (!isCallLatencyEnabled()) return;
  if (!id) return;
  const t = timelinesByAnyId.get(id);
  if (!t) return;
  if (t.summarized) return;
  if (t.entries.length < 2) return;
  t.summarized = true;

  const lines: string[] = [];
  lines.push(`[CALL_LATENCY] --- TIMELINE id=${t.primaryId} reason=${reason} ---`);
  // Print each entry; column-aligned.
  const longestEvent = t.entries.reduce(
    (m, e) => Math.max(m, e.event.length),
    0,
  );
  for (const e of t.entries) {
    const pad = " ".repeat(Math.max(0, longestEvent - e.event.length));
    lines.push(
      `  ${e.event}${pad}  +${e.delta}ms  total=${e.total}ms${
        e.ctx ? " " + safeJson(e.ctx) : ""
      }`,
    );
  }

  // Answer → Audio latency (the user-facing KPI).
  const answerTap = t.firstSeen.get("ANSWER_TAPPED");
  const audioOut =
    t.firstSeen.get("FIRST_AUDIO_PACKET") ??
    t.firstSeen.get("AUDIO_OUTPUT_STARTED") ??
    t.firstSeen.get("CALL_ACTIVE_UI");
  if (answerTap && audioOut && audioOut >= answerTap) {
    const ms = audioOut - answerTap;
    lines.push(`ANSWER → AUDIO: ${ms}ms`);
    const severity = severityFor(ms);
    lines.push(`SEVERITY: ${severity} (target <200ms, got ${ms}ms)`);
  }

  // Bottleneck — largest delta between consecutive entries, ignoring the
  // first (which is always 0) and the ANSWER_TAPPED gap (user think
  // time, not an app bug). Ringing while waiting for the user to answer
  // is also ignored because the user controls that duration.
  let worst: TimelineEntry | null = null;
  for (let i = 1; i < t.entries.length; i += 1) {
    const e = t.entries[i];
    // ANSWER_TAPPED's delta captures user think-time — never an app bug,
    // so it can never be the bottleneck in the "we made the app slow"
    // sense the user cares about.
    if (e.event === "ANSWER_TAPPED") continue;
    if (!worst || e.delta > worst.delta) worst = e;
  }
  if (worst) {
    const sev = severityFor(worst.delta);
    lines.push(
      `BOTTLENECK: ${worst.event} (+${worst.delta}ms) [${sev}]`,
    );
  }

  // Missing-event diagnosis — any canonical event that never fired?
  const missing = EVENT_ORDER.filter((ev) => !t.firstSeen.has(ev));
  if (missing.length) {
    lines.push(`MISSING: ${missing.join(", ")}`);
  }

  if (Object.keys(t.context).length) {
    lines.push(`CTX: ${safeJson(t.context)}`);
  }

  lines.push(`[CALL_LATENCY] --- END id=${t.primaryId} ---`);

  for (const line of lines) emit(line);
}

/**
 * Drop the timeline — typically called at the very end of a call after
 * `summarizeCallLatency` has printed its summary so the in-memory store
 * doesn't grow unbounded.
 */
export function resetCallLatency(id: string | null | undefined): void {
  if (!id) return;
  const t = timelinesByAnyId.get(id);
  if (!t) return;
  dropTimeline(t);
}

/**
 * Produce a plain snapshot of the timeline — useful for embedding inside
 * `CallFlightRecorder` uploads or for a UI debug panel.
 */
export function snapshotCallLatency(id: string | null | undefined): Timeline | null {
  if (!id) return null;
  return timelinesByAnyId.get(id) ?? null;
}

// ──────────────────────────────────────────────────────────────────────
// Helpers

function severityFor(ms: number): "OK" | "WARNING" | "PROBLEM" | "CRITICAL" {
  if (ms > 1000) return "CRITICAL";
  if (ms > 500) return "PROBLEM";
  if (ms > 300) return "WARNING";
  return "OK";
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return "<unserializable>";
  }
}
