/**
 * Client-trace batches — the web/desktop softphone's own account of what it did.
 *
 * ⛔ WHY THIS EXISTS (2026-09-03): for weeks every "caller hears me, I don't hear
 * the caller" headset ticket could only be diagnosed by remote-controlling the
 * customer's screen, because the softphone recorded NOTHING about which
 * microphone/speaker it picked, whether `setSinkId` actually applied, or what
 * the person pressed. The client now batches those facts here as
 * `VoiceDiagEvent` rows of type CLIENT_TRACE, structured by `payload.kind`.
 *
 * This module is PURE (no db, no Fastify) so the shape rules are testable and
 * so the route stays a thin wrapper: read the token, find the session, apply
 * the per-session rate limit, normalise, sanitise, insert.
 *
 * Bounds are the safety: a client can never send more than MAX_EVENTS_PER_BATCH
 * rows per POST, a row's timestamp can never be more than a few minutes off the
 * server's clock (a stale buffer replayed after a laptop sleep must not land
 * "in the past" and confuse the timeline), an unknown kind is dropped rather
 * than stored (the allowlist IS the schema), and every string is trimmed.
 */

export const CLIENT_TRACE_KINDS = [
  // devices
  "device_inventory",
  "mic_auto_picked",
  "mic_selected",
  "mic_select_failed",
  "speaker_selected",
  "speaker_select_failed",
  "speaker_toggle",
  "ringer_selected",
  // per-call media path
  "mic_opened",
  "mic_open_failed",
  "remote_audio_attached",
  "remote_audio_play_blocked",
  "one_way_audio",
  "incoming_audio_resumed",
  "remote_track_muted",
  "remote_track_unmuted",
  "remote_track_ended",
  "call_end",
  // 2026-09-04: the 10-second media sample — packets in/out, loss, jitter, RTT,
  // ICE path AND audio LEVELS both ways (rxLevel/txLevel = RMS over the
  // interval, from getStats totalAudioEnergy/totalSamplesDuration deltas).
  // This is the number every big call platform runs on: "audio energy arrived"
  // vs "nothing arrived" vs "it arrived and was silent".
  "media_sample",
  // signalling / ui
  "reg_state",
  "press",
  "settings_opened",
  // the desktop shell's own facts (version, OS, window kind) and a bounded
  // tail of its log file at call end (apps/desktop connect.log)
  "shell_info",
  "shell_log",
  // ⛔ SERVER-AUTHORED. The api computes a verdict for each call from the rows
  // above (voice/callVerdict.ts) and stores it as its own CLIENT_TRACE row.
  // A client may never write it — see SERVER_ONLY_KINDS.
  "verdict",
] as const;

export type ClientTraceKind = (typeof CLIENT_TRACE_KINDS)[number];

/**
 * Kinds only the api itself writes. A client batch carrying one is DROPPED and
 * counted — a page must not be able to forge the conclusion support reads.
 */
export const SERVER_ONLY_KINDS: ReadonlySet<string> = new Set(["verdict"]);

export const MAX_EVENTS_PER_BATCH = 50;
/** A buffered event older than this is stamped `now` — it is still kept. */
export const MAX_CLIENT_SKEW_PAST_MS = 15 * 60 * 1000;
export const MAX_CLIENT_SKEW_FUTURE_MS = 60 * 1000;
const MAX_FACT_KEYS = 40;
const MAX_STRING = 300;
const MAX_LIST = 40;

const KIND_SET: ReadonlySet<string> = new Set(CLIENT_TRACE_KINDS);

export interface NormalizedTraceRow {
  createdAt: Date;
  payload: Record<string, unknown>;
}

export interface NormalizedTraceBatch {
  sessionId: string | null;
  rows: NormalizedTraceRow[];
  /** Events refused (unknown kind, malformed) — reported back so a client bug is visible, never silent. */
  dropped: number;
  /** Events past the per-batch cap — the client should not be sending these. */
  overflow: number;
}

function clampAt(raw: unknown, nowMs: number): Date {
  const t = typeof raw === "string" || typeof raw === "number" ? new Date(raw).getTime() : NaN;
  if (!Number.isFinite(t)) return new Date(nowMs);
  if (t < nowMs - MAX_CLIENT_SKEW_PAST_MS) return new Date(nowMs);
  if (t > nowMs + MAX_CLIENT_SKEW_FUTURE_MS) return new Date(nowMs);
  return new Date(t);
}

function trimValue(v: unknown, depth = 0): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === "string") return v.length > MAX_STRING ? v.slice(0, MAX_STRING) : v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v;
  // facts (0) → inputs list (1) → { id, label } (2) is the deepest real shape
  // (device_inventory). One more level is allowed; anything deeper is dropped.
  if (depth >= 3) return undefined;
  if (Array.isArray(v)) return v.slice(0, MAX_LIST).map((x) => trimValue(x, depth + 1));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (n++ >= MAX_FACT_KEYS) break;
      const t = trimValue(val, depth + 1);
      if (t !== undefined) out[String(k).slice(0, 64)] = t;
    }
    return out;
  }
  return undefined;
}

/**
 * Turn a raw request body into insertable rows. Never throws on the body's
 * shape — a malformed batch yields `sessionId: null` (the route answers 400)
 * or dropped rows, so one bad event can never cost the good ones beside it.
 */
export function normalizeClientTraceBatch(input: unknown, nowMs: number): NormalizedTraceBatch {
  const body = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const sessionId = typeof body.sessionId === "string" && body.sessionId.trim().length > 0 && body.sessionId.length <= 64
    ? body.sessionId.trim()
    : null;
  const list = Array.isArray(body.events) ? body.events : [];
  const overflow = Math.max(0, list.length - MAX_EVENTS_PER_BATCH);
  const rows: NormalizedTraceRow[] = [];
  let dropped = 0;
  for (const ev of list.slice(0, MAX_EVENTS_PER_BATCH)) {
    if (!ev || typeof ev !== "object" || Array.isArray(ev)) { dropped++; continue; }
    const e = ev as Record<string, unknown>;
    const kind = typeof e.kind === "string" ? e.kind : "";
    if (!KIND_SET.has(kind) || SERVER_ONLY_KINDS.has(kind)) { dropped++; continue; }
    const facts = trimValue(e.facts && typeof e.facts === "object" && !Array.isArray(e.facts) ? e.facts : {}, 0) as Record<string, unknown>;
    // `kind` always wins over anything a client put in facts under the same name.
    const payload: Record<string, unknown> = { ...facts, kind };
    if (typeof e.at === "string" || typeof e.at === "number") payload.clientAt = String(e.at).slice(0, 40);
    rows.push({ createdAt: clampAt(e.at, nowMs), payload });
  }
  return { sessionId, rows, dropped, overflow };
}
