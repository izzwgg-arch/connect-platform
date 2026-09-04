/**
 * Call verdict — one plain-English conclusion per call, computed by the api
 * from the softphone's own CLIENT_TRACE rows (voice/clientTraceBatch.ts).
 *
 * ⛔ WHY (2026-09-04, Izzy: "build the thing that's not built yet"): a timeline
 * of 500 events is evidence, not a diagnosis. The big call platforms (Twilio
 * Voice Insights, Zoom, Meet) classify every call — "one-way audio",
 * "audio input silent", "high jitter" — so a support person reads a LABEL.
 * This is that label, and the support watcher reads it before it reads anything
 * else (tools/loopcom-support-mcp get_call_diagnostics).
 *
 * PURE: rows in, verdict out. No db, no Fastify. The route stores the result
 * as a server-authored CLIENT_TRACE row of kind "verdict" (a client cannot write
 * that kind — SERVER_ONLY_KINDS).
 *
 * The ordering of the checks IS the diagnosis: a failed mic beats everything,
 * then what the browser refused to play, then what the network delivered, then
 * the device split, then network quality. Earlier codes are things the person
 * could not have heard through; later ones are degradations.
 */

export type CallVerdictCode =
  | "mic_open_failed"
  | "playback_blocked"
  | "speaker_apply_failed"
  | "no_inbound_rtp"
  | "inbound_silent"
  | "mic_silent"
  | "remote_track_lost"
  | "split_devices"
  | "poor_network"
  | "ok"
  | "short_call"
  | "no_data";

export interface CallVerdict {
  code: CallVerdictCode;
  /** One sentence a support person can say to the customer. */
  headline: string;
  /** The measurements behind it, one per line. */
  evidence: string[];
  /** Compact numbers for the screen and the watcher. */
  facts: {
    samples: number;
    durationMs: number | null;
    rxPkts: number;
    txPkts: number;
    lost: number;
    lossPct: number | null;
    rxLevelMax: number | null;
    txLevelMax: number | null;
    rttMedianMs: number | null;
    jitterMaxMs: number | null;
    relay: boolean | null;
    micLabel: string | null;
    speakerLabel: string | null;
  };
}

export interface TraceRowLike {
  createdAt: Date | string;
  payload: Record<string, unknown> | null | undefined;
}

/** RMS below this over a whole 10 s window is silence (≈ -48 dBFS). Speech sits at 0.02–0.2. */
export const SILENCE_RMS = 0.004;
/** Fewer packets than this in either direction says nothing — a 10 s window at 20 ms ptime is 500. */
const MIN_PACKETS_FOR_JUDGEMENT = 50;
const SHORT_CALL_MS = 3_000;
const POOR_LOSS_PCT = 5;
const POOR_RTT_MS = 400;
const POOR_JITTER_MS = 60;

const HEADSET_RE = /headset|hands-free|handsfree|jabra|plantronics|poly |poly\b|bluetooth|airpods|earphone|headphone|logitech|yealink|sennheiser|epos/i;

function kindOf(r: TraceRowLike): string {
  const k = r.payload?.kind;
  return typeof k === "string" ? k : "";
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}
function ms(d: Date | string): number {
  const t = d instanceof Date ? d.getTime() : new Date(d).getTime();
  return Number.isFinite(t) ? t : 0;
}
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}
function pct(level: number | null): string {
  return level === null ? "n/a" : `${(level * 100).toFixed(1)}%`;
}
function looksLikeHeadset(label: string | null): boolean | null {
  if (!label) return null;
  if (/system default|^default$/i.test(label)) return false;
  return HEADSET_RE.test(label);
}

/**
 * Select the rows that belong to the call that just ended: everything from the
 * last `mic_opened` (or dial/answer press) before `call_end`, bounded by the
 * reported duration plus a grace. Rows from a previous call on the same
 * session must not leak into this verdict.
 */
export function selectCallWindow(rows: TraceRowLike[], callEnd?: TraceRowLike): TraceRowLike[] {
  const sorted = [...rows].sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
  const end = callEnd ?? [...sorted].reverse().find((r) => kindOf(r) === "call_end");
  if (!end) return sorted;
  const endAt = ms(end.createdAt);
  const duration = num(end.payload?.durationMs);
  const floor = duration !== null ? endAt - duration - 15_000 : endAt - 60 * 60_000;
  const before = sorted.filter((r) => ms(r.createdAt) <= endAt && ms(r.createdAt) >= floor);
  // Start at the last call-start marker inside the window, if there is one.
  let startIdx = 0;
  for (let i = before.length - 1; i >= 0; i--) {
    const k = kindOf(before[i]!);
    const action = before[i]!.payload?.action;
    if (k === "mic_opened" || (k === "press" && (action === "dial" || action === "answer"))) { startIdx = i; break; }
  }
  return before.slice(startIdx);
}

export function computeCallVerdict(rowsIn: TraceRowLike[], callEnd?: TraceRowLike): CallVerdict {
  const rows = selectCallWindow(rowsIn, callEnd);
  const end = callEnd ?? [...rows].reverse().find((r) => kindOf(r) === "call_end");
  const has = (k: string) => rows.some((r) => kindOf(r) === k);
  const last = (k: string) => [...rows].reverse().find((r) => kindOf(r) === k)?.payload ?? null;

  const samples = rows.filter((r) => kindOf(r) === "media_sample").map((r) => r.payload!);
  let rxPkts = 0, txPkts = 0, lost = 0;
  let rxLevelMax: number | null = null, txLevelMax: number | null = null;
  const rtts: number[] = []; let jitterMax: number | null = null; let relay: boolean | null = null;
  for (const s of samples) {
    rxPkts += num(s.rxPkts) ?? 0; txPkts += num(s.txPkts) ?? 0; lost += num(s.lost) ?? 0;
    const rl = num(s.rxLevel); if (rl !== null) rxLevelMax = Math.max(rxLevelMax ?? 0, rl);
    const tl = num(s.txLevel); if (tl !== null) txLevelMax = Math.max(txLevelMax ?? 0, tl);
    const rtt = num(s.rttMs); if (rtt !== null) rtts.push(rtt);
    const j = num(s.jitterMs); if (j !== null) jitterMax = Math.max(jitterMax ?? 0, j);
    if (typeof s.relay === "boolean") relay = s.relay;
  }
  const lossPct = rxPkts + lost > 0 ? Math.round((lost / (rxPkts + lost)) * 1000) / 10 : null;
  const rttMedian = median(rtts);

  const micOpened = last("mic_opened");
  const micAuto = last("mic_auto_picked");
  const attached = last("remote_audio_attached");
  const spk = last("speaker_selected");
  const micLabel = str(micOpened?.label) ?? str(micAuto?.label) ?? str(end?.payload?.micLabel);
  const speakerLabel = str(attached?.sinkLabel) ?? str(spk?.label) ?? str(end?.payload?.speakerLabel) ?? str(micAuto?.speakerLabel);
  const durationMs = num(end?.payload?.durationMs);

  const facts: CallVerdict["facts"] = {
    samples: samples.length, durationMs, rxPkts, txPkts, lost, lossPct,
    rxLevelMax, txLevelMax, rttMedianMs: rttMedian, jitterMaxMs: jitterMax, relay, micLabel, speakerLabel,
  };
  const evidence: string[] = [];
  const verdict = (code: CallVerdictCode, headline: string): CallVerdict => ({ code, headline, evidence, facts });

  if (micLabel) evidence.push(`Mic: ${micLabel}`);
  if (speakerLabel) evidence.push(`Speaker: ${speakerLabel}`);
  if (samples.length) {
    evidence.push(`${samples.length} media samples: ${rxPkts} pkts in / ${txPkts} out, loss ${lossPct ?? 0}%, RTT ${rttMedian ?? "n/a"} ms, jitter max ${jitterMax ?? "n/a"} ms${relay ? ", via TURN relay" : ""}`);
    evidence.push(`Audio level in: peak ${pct(rxLevelMax)} · out: peak ${pct(txLevelMax)} (silence < ${pct(SILENCE_RMS)})`);
  }

  if (durationMs !== null && durationMs < SHORT_CALL_MS) {
    return verdict("short_call", `The call lasted ${Math.round(durationMs / 1000)} s — too short to judge audio.`);
  }
  const micFail = last("mic_open_failed");
  if (micFail) {
    evidence.push(`Mic open failed: ${str(micFail.error) ?? "unknown"} on "${str(micFail.label) ?? "?"}"`);
    return verdict("mic_open_failed", "The app could not open the microphone, so the caller heard nothing from this side.");
  }
  const blocked = last("remote_audio_play_blocked");
  if (blocked) {
    evidence.push(`Playback blocked on "${str(blocked.sinkLabel) ?? "?"}": ${str(blocked.error) ?? "unknown"}`);
    return verdict("playback_blocked", "The browser refused to play the caller's audio — the person could not hear the caller.");
  }
  const spkFail = last("speaker_select_failed");
  if (spkFail && str(spkFail.error) !== "no_audio_element") {
    evidence.push(`Speaker "${str(spkFail.label) ?? "?"}" failed to apply: ${str(spkFail.error) ?? "unknown"} (${str(spkFail.why) ?? ""})`);
    return verdict("speaker_apply_failed", `The chosen speaker "${str(spkFail.label) ?? "?"}" could not be applied — call audio went to the Windows default output instead.`);
  }
  if (samples.length >= 1 && txPkts >= MIN_PACKETS_FOR_JUDGEMENT && rxPkts < MIN_PACKETS_FOR_JUDGEMENT) {
    return verdict("no_inbound_rtp", "Nothing arrived from the network — this side sent audio but received none. Network/PBX path, not the headset.");
  }
  if (samples.length >= 2 && rxPkts >= MIN_PACKETS_FOR_JUDGEMENT && rxLevelMax !== null && rxLevelMax < SILENCE_RMS) {
    return verdict("inbound_silent", "Audio packets arrived but carried silence — the far end's microphone, or a muted remote track.");
  }
  if (samples.length >= 2 && txPkts >= MIN_PACKETS_FOR_JUDGEMENT && txLevelMax !== null && txLevelMax < SILENCE_RMS) {
    return verdict("mic_silent", `The microphone "${micLabel ?? "?"}" captured silence for the whole call — the caller could not hear this person.`);
  }
  if ((has("remote_track_ended") || (has("remote_track_muted") && !has("remote_track_unmuted"))) && !has("incoming_audio_resumed")) {
    return verdict("remote_track_lost", "The caller's audio track stopped mid-call and never came back.");
  }
  const micHs = looksLikeHeadset(micLabel);
  const spkHs = looksLikeHeadset(speakerLabel);
  if (micHs === true && spkHs === false && speakerLabel) {
    evidence.push("Mic is a headset, speaker is not: the caller's voice plays out of a different device");
    return verdict("split_devices", `Mic on "${micLabel}" but the caller's audio on "${speakerLabel}" — the headset-mic-only shape. Pick the headset for the speaker too.`);
  }
  if (samples.length >= 1 && ((lossPct ?? 0) > POOR_LOSS_PCT || (rttMedian ?? 0) > POOR_RTT_MS || (jitterMax ?? 0) > POOR_JITTER_MS)) {
    return verdict("poor_network", `Audio flowed both ways but the network was poor (loss ${lossPct ?? 0}%, RTT ${rttMedian ?? "n/a"} ms, jitter ${jitterMax ?? "n/a"} ms).`);
  }
  if (samples.length === 0) {
    return verdict("no_data", "No media samples for this call — a window on the old build, or a call under 10 seconds.");
  }
  return verdict("ok", "Audio flowed both ways with sound on the line; devices and network look healthy.");
}
