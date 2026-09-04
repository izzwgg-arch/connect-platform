"use client";

import { useState } from "react";
import { PageHeader } from "../../../../components/PageHeader";
import { PermissionGate } from "../../../../components/PermissionGate";
import { apiGet, apiPost } from "../../../../services/apiClient";

// ── Types ────────────────────────────────────────────────────────────────────

interface TimelineEvent {
  id: string;
  type: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

interface TimelineSession {
  id: string;
  userId: string;
  userEmail: string;
  platform: string;
  startedAt: string;
  endedAt: string | null;
  lastRegState: string;
  lastCallState: string;
  iceHasTurn: boolean;
  events: TimelineEvent[];
}

interface DiagExplain {
  summary: string;
  whatHappened: string;
  likelyCause: string;
  suggestedFix: string;
  confidence: string;
  grade: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const EVENT_ICONS: Record<string, string> = {
  SESSION_START: "🟢",
  SESSION_HEARTBEAT: "💓",
  SIP_REGISTER: "✅",
  SIP_UNREGISTER: "🔓",
  WS_CONNECTED: "🔌",
  WS_DISCONNECTED: "⚡",
  WS_RECONNECT: "🔄",
  ICE_GATHERING: "🧊",
  ICE_SELECTED_PAIR: "🧊",
  TURN_TEST_RESULT: "🔁",
  INCOMING_INVITE: "📞",
  ANSWER_TAPPED: "✅",
  CALL_CONNECTED: "🟢",
  CALL_ENDED: "🔴",
  ERROR: "🚨",
  MEDIA_TEST_RUN: "🎙",
  CALL_QUALITY_REPORT: "📊",
  CLIENT_TRACE: "🎧",
};

// ── Client trace (CLIENT_TRACE rows, structured by payload.kind) ──────────────
// What the softphone itself wrote down: device inventory, every mic/speaker/
// ringer pick and whether it APPLIED, the devices a call really used, remote
// audio attach/play, one-way detection, registration state, every press.

const TRACE_ICONS: Record<string, string> = {
  device_inventory: "🔌",
  mic_auto_picked: "🎤",
  mic_selected: "🎤",
  mic_select_failed: "🚫",
  speaker_selected: "🔊",
  speaker_select_failed: "🚫",
  speaker_toggle: "📣",
  ringer_selected: "🔔",
  mic_opened: "🎤",
  mic_open_failed: "🚫",
  remote_audio_attached: "🔊",
  remote_audio_play_blocked: "🔇",
  one_way_audio: "🔇",
  incoming_audio_resumed: "🔊",
  remote_track_muted: "🔇",
  remote_track_unmuted: "🔊",
  remote_track_ended: "🔇",
  call_end: "🔴",
  media_sample: "📈",
  verdict: "🧭",
  reg_state: "📶",
  press: "👆",
  settings_opened: "⚙️",
  shell_info: "🖥",
  shell_log: "📜",
};

const TRACE_BAD = new Set(["mic_select_failed", "speaker_select_failed", "mic_open_failed", "remote_audio_play_blocked", "one_way_audio", "remote_track_muted", "remote_track_ended"]);
/** Verdict codes that mean the person could not have heard / been heard. */
const VERDICT_BAD = new Set(["mic_open_failed", "playback_blocked", "speaker_apply_failed", "no_inbound_rtp", "inbound_silent", "mic_silent", "remote_track_lost"]);
const VERDICT_WARN = new Set(["split_devices", "poor_network"]);
function pctLevel(v: unknown): string {
  return typeof v === "number" ? `${(v * 100).toFixed(1)}%` : "n/a";
}

function traceKind(p: Record<string, unknown>): string {
  return typeof p.kind === "string" ? p.kind : "";
}

function devList(v: unknown): string {
  if (!Array.isArray(v) || v.length === 0) return "none";
  return v.map((d) => (d && typeof d === "object" ? String((d as { label?: unknown }).label || "(no label)") : "?")).join(" · ");
}

/** One human line per trace kind — the thing support reads first. */
function traceSummary(p: Record<string, unknown>): string {
  const s = (k: string) => (p[k] === undefined || p[k] === null ? "" : String(p[k]));
  switch (traceKind(p)) {
    case "device_inventory":
      return `Mics: ${devList(p.inputs)} — Speakers: ${devList(p.outputs)}${s("why") ? ` (${s("why")})` : ""}`;
    case "mic_auto_picked":
      return `App auto-picked mic "${s("label")}" — speaker left on "${s("speakerLabel")}"`;
    case "mic_selected":
      return `Mic set to "${s("label")}"`;
    case "mic_select_failed":
      return `Mic "${s("label")}" could not be selected: ${s("error")}`;
    case "speaker_selected":
      return `Speaker set to "${s("label")}" (${s("why")})${p.applied === false ? " — browser has no setSinkId, OS default plays" : ""}`;
    case "speaker_select_failed":
      return `⛔ Speaker "${s("label")}" FAILED to apply: ${s("error")} (${s("why")}) — call audio is on the Windows default output`;
    case "speaker_toggle":
      return p.on ? `Speaker button ON → "${s("to")}"` : `Speaker button OFF → back to "${s("backTo")}"`;
    case "ringer_selected":
      return `Ringer set to "${s("label") || "System default"}"`;
    case "mic_opened":
      return `Call mic: "${s("label")}"${s("source") === "remote_desktop" ? " (from remote desktop)" : ""}${p.muted ? " — track MUTED" : ""}`;
    case "mic_open_failed":
      return `⛔ Could not open mic "${s("label")}": ${s("error")}`;
    case "remote_audio_attached":
      return `Caller audio playing on "${s("sinkLabel")}"${p.live === false ? " — no live track" : ""}${p.muted ? " — element muted" : ""}`;
    case "remote_audio_play_blocked":
      return `⛔ Browser blocked playback on "${s("sinkLabel")}": ${s("error")}`;
    case "one_way_audio":
      return `⛔ No incoming audio for 8s (RTT ${s("rttMs")}ms, ${s("packetsReceived")} pkts) — nothing arriving from the network`;
    case "incoming_audio_resumed":
      return "Incoming audio resumed";
    case "remote_track_muted":
      return "⛔ Remote audio track muted (PBX stopped sending / hold)";
    case "remote_track_unmuted":
      return "Remote audio track resumed";
    case "remote_track_ended":
      return "⛔ Remote audio track ended";
    case "call_end":
      return `Call ended: ${s("endReason")} · ${Math.round(Number(p.durationMs || 0) / 1000)}s · mic "${s("micLabel")}" · speaker "${s("speakerLabel")}"${p.remoteAudioSeen === false ? " · ⛔ remote audio never attached" : ""}${s("lastCallError") ? ` · ${s("lastCallError")}` : ""}`;
    case "media_sample":
      return `t+${s("t")}s · in ${s("rxPkts")} pkts / level ${pctLevel(p.rxLevel)} · out ${s("txPkts")} pkts / level ${pctLevel(p.txLevel)} · loss ${s("lost")} · RTT ${s("rttMs")}ms · jitter ${s("jitterMs")}ms${p.relay ? " · relay" : ""}`;
    case "verdict":
      return `${VERDICT_BAD.has(s("code")) ? "⛔ " : VERDICT_WARN.has(s("code")) ? "⚠️ " : "✅ "}VERDICT ${s("code")}: ${s("headline")}`;
    case "shell_info":
      return `Desktop app ${s("version")} · ${s("os")} · window ${s("windowKind")}${s("electron") ? ` · Electron ${s("electron")}` : ""}`;
    case "shell_log":
      return `Desktop shell log: ${Array.isArray(p.lines) ? p.lines.length : 0} lines${Number(p.truncated) > 0 ? ` (+${s("truncated")} cut)` : ""}`;
    case "reg_state":
      return `Registration: ${s("state")}${Number(p.changes) > 1 ? ` (${s("changes")} changes in the last ${s("windowS")}s)` : ""}`;
    case "press":
      return `Pressed ${s("action")}${p.hadSession === false ? " — ⛔ no call session (silent no-op)" : ""}${s("callState") ? ` while ${s("callState")}` : ""}`;
    case "settings_opened":
      return `Opened settings (${s("surface")})`;
    default:
      return traceKind(p) || "trace";
  }
}

const EVENT_COLORS: Record<string, string> = {
  CALL_CONNECTED: "#16a34a",
  CALL_ENDED: "#dc2626",
  ERROR: "#dc2626",
  INCOMING_INVITE: "#2563eb",
  ANSWER_TAPPED: "#16a34a",
  SIP_REGISTER: "#16a34a",
  SIP_UNREGISTER: "#d97706",
  WS_DISCONNECTED: "#d97706",
  CALL_QUALITY_REPORT: "#7c3aed",
  ICE_SELECTED_PAIR: "#0891b2",
  TURN_TEST_RESULT: "#0891b2",
};

function fmt(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
}

function elapsed(from: string, to: string) {
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (ms < 0) return "";
  if (ms < 1000) return `+${ms}ms`;
  return `+${(ms / 1000).toFixed(1)}s`;
}

function gradeColor(g: string | null) {
  if (!g) return "#6b7280";
  if (g === "excellent") return "#16a34a";
  if (g === "good") return "#2563eb";
  if (g === "fair") return "#d97706";
  return "#dc2626";
}

// ── Event detail panel ────────────────────────────────────────────────────────

function EventDetail({ event, sessionStart }: { event: TimelineEvent; sessionStart: string }) {
  const [open, setOpen] = useState(false);
  const p = event.payload;
  const isTrace = event.type === "CLIENT_TRACE";
  const kind = isTrace ? traceKind(p) : "";
  const icon = isTrace ? (TRACE_ICONS[kind] ?? "🎧") : (EVENT_ICONS[event.type] ?? "•");
  const color = isTrace ? (TRACE_BAD.has(kind) ? "#dc2626" : kind === "press" ? "#94a3b8" : "#0ea5e9") : (EVENT_COLORS[event.type] ?? "#6b7280");
  const title = isTrace ? kind.replace(/_/g, " ") : event.type.replace(/_/g, " ");
  const grade = typeof p["qualityGrade"] === "string" ? p["qualityGrade"] : null;
  const rcaRaw = p["rca"];
  const rca: Record<string, string> | null =
    rcaRaw && typeof rcaRaw === "object" && !Array.isArray(rcaRaw)
      ? Object.fromEntries(Object.entries(rcaRaw as Record<string, unknown>).map(([k, v]) => [k, String(v ?? "")]))
      : null;

  return (
    <div style={{ display: "flex", gap: 12, padding: "6px 0", borderBottom: "1px solid #1f2937", cursor: "pointer" }}
      onClick={() => setOpen(o => !o)}>
      {/* Timeline line + dot */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 24, flexShrink: 0 }}>
        <div style={{ width: 10, height: 10, borderRadius: "50%", background: color, flexShrink: 0, marginTop: 4 }} />
        <div style={{ flex: 1, width: 2, background: "#374151" }} />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: color }}>
            {icon} {title}
          </span>
          {grade && (
            <span style={{ fontSize: 11, padding: "1px 6px", borderRadius: 4, background: gradeColor(grade) + "33", color: gradeColor(grade), fontWeight: 700 }}>
              {grade.toUpperCase()}
            </span>
          )}
          <span style={{ fontSize: 11, color: "#6b7280", marginLeft: "auto" }}>
            {fmt(event.createdAt)}
            <span style={{ marginLeft: 6, color: "#4b5563" }}>{elapsed(sessionStart, event.createdAt)}</span>
          </span>
        </div>

        {/* Quick summary line */}
        {event.type === "CALL_QUALITY_REPORT" && (
          <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 2 }}>
            RTT {typeof p.rttMs === "number" ? `${p.rttMs}ms` : "—"} &nbsp;|&nbsp;
            Jitter {typeof p.jitterMs === "number" ? `${p.jitterMs}ms` : "—"} &nbsp;|&nbsp;
            Loss {typeof p.packetsLost === "number" ? p.packetsLost : "—"} pkts &nbsp;|&nbsp;
            {p.isUsingRelay ? "🔁 TURN" : "⚠ No TURN"} &nbsp;|&nbsp;
            {String(p.audioCodec ?? "?")}
          </div>
        )}
        {event.type === "ICE_SELECTED_PAIR" && (
          <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 2 }}>
            {String(p["localCandidateType"] ?? "")} → {String(p["remoteCandidateType"] ?? "")} &nbsp;|&nbsp;
            {p["isRelay"] ? "🔁 relay" : "direct"}
          </div>
        )}
        {event.type === "ERROR" && (
          <div style={{ fontSize: 12, color: "#f87171", marginTop: 2 }}>{String(p["message"] ?? p["error"] ?? "")}</div>
        )}
        {isTrace && (
          <div style={{ fontSize: 12, color: TRACE_BAD.has(kind) ? "#fca5a5" : "#9ca3af", marginTop: 2, whiteSpace: "pre-wrap" }}>{traceSummary(p)}</div>
        )}

        {/* RCA block */}
        {rca && (
          <div style={{ marginTop: 4, padding: "6px 8px", background: "#1f2937", borderRadius: 6, borderLeft: "3px solid #7c3aed" }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#c4b5fd" }}>
              Root cause: {(rca.primaryCause ?? "").replace(/_/g, " ")}
              <span style={{ marginLeft: 8, fontWeight: 400, color: "#9ca3af" }}>({rca.confidence ?? ""} confidence)</span>
            </div>
            {rca.suggestedAction && rca.suggestedAction !== "none" && (
              <div style={{ fontSize: 11, color: "#a78bfa", marginTop: 2 }}>
                → {rca.suggestedAction.replace(/_/g, " ")}
              </div>
            )}
          </div>
        )}

        {/* Expanded raw payload */}
        {open && (
          <pre style={{ fontSize: 11, color: "#9ca3af", background: "#111827", padding: 8, borderRadius: 6, marginTop: 6, overflowX: "auto", maxHeight: 200 }}>
            {JSON.stringify(event.payload, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

// ── AI plain-English explanation panel ───────────────────────────────────────

function AiExplainPanel({ sessionId, tenantId }: { sessionId: string; tenantId?: string }) {
  const [explain, setExplain] = useState<DiagExplain | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiPost<DiagExplain>("/admin/voice/diag/explain", { sessionId, tenantId });
      setExplain(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load explanation");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ background: "#0f172a", border: "1px solid #1e3a5f", borderRadius: 10, padding: 16, marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <span style={{ color: "#93c5fd", fontWeight: 700, fontSize: 14 }}>🤖 AI Diagnostic Summary</span>
        <button onClick={load} disabled={loading} style={{
          background: "#1d4ed8", color: "#fff", border: "none", borderRadius: 6, padding: "6px 14px",
          fontSize: 12, cursor: loading ? "default" : "pointer", opacity: loading ? 0.6 : 1,
        }}>
          {loading ? "Analyzing…" : "Explain this session"}
        </button>
      </div>

      {error && <div style={{ color: "#f87171", fontSize: 12 }}>{error}</div>}

      {explain && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {/* Summary headline */}
          <div style={{ fontSize: 15, fontWeight: 700, color: "#e2e8f0" }}>
            {explain.grade && (
              <span style={{ padding: "2px 8px", borderRadius: 5, background: gradeColor(explain.grade) + "22", color: gradeColor(explain.grade), marginRight: 8, fontSize: 12 }}>
                {explain.grade.toUpperCase()}
              </span>
            )}
            {explain.summary}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <div style={{ background: "#1e293b", borderRadius: 8, padding: 12 }}>
              <div style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>What happened</div>
              <div style={{ fontSize: 13, color: "#cbd5e1" }}>{explain.whatHappened}</div>
            </div>
            <div style={{ background: "#1e293b", borderRadius: 8, padding: 12 }}>
              <div style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>Likely cause</div>
              <div style={{ fontSize: 13, color: "#fbbf24" }}>{explain.likelyCause}</div>
            </div>
            <div style={{ background: "#1e293b", borderRadius: 8, padding: 12 }}>
              <div style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>Suggested fix</div>
              <div style={{ fontSize: 13, color: "#86efac" }}>{explain.suggestedFix}</div>
            </div>
          </div>

          <div style={{ fontSize: 11, color: "#4b5563" }}>Confidence: {explain.confidence}</div>
        </div>
      )}
    </div>
  );
}

// ── Devices & audio card — the headset ticket, answered from the database ────

function lastTrace(events: TimelineEvent[], kind: string): Record<string, unknown> | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "CLIENT_TRACE" && traceKind(e.payload) === kind) return e.payload;
  }
  return null;
}

function countTrace(events: TimelineEvent[], kind: string): number {
  return events.filter((e) => e.type === "CLIENT_TRACE" && traceKind(e.payload) === kind).length;
}

function DevicesCard({ events }: { events: TimelineEvent[] }) {
  const hasTrace = events.some((e) => e.type === "CLIENT_TRACE");
  if (!hasTrace) {
    return (
      <div style={{ background: "#1f2937", border: "1px dashed #374151", borderRadius: 10, padding: 12, marginBottom: 16, fontSize: 12, color: "#9ca3af" }}>
        🎧 No client trace on this session yet — the app records devices and presses only from the build shipped 2026-09-03; an already-open window keeps the old bundle until it is fully closed and reopened.
      </div>
    );
  }
  const inv = lastTrace(events, "device_inventory");
  const micOpened = lastTrace(events, "mic_opened");
  const micAuto = lastTrace(events, "mic_auto_picked");
  const spk = lastTrace(events, "speaker_selected");
  const spkFail = lastTrace(events, "speaker_select_failed");
  const attached = lastTrace(events, "remote_audio_attached");
  const ringer = lastTrace(events, "ringer_selected");
  const reg = lastTrace(events, "reg_state");
  const nSpkFail = countTrace(events, "speaker_select_failed");
  const nMicFail = countTrace(events, "mic_open_failed") + countTrace(events, "mic_select_failed");
  const nOneWay = countTrace(events, "one_way_audio");
  const nBlocked = countTrace(events, "remote_audio_play_blocked");
  const s = (o: Record<string, unknown> | null, k: string) => (o && o[k] !== undefined && o[k] !== null ? String(o[k]) : "");

  const callMic = s(micOpened, "label") || s(micAuto, "label") || "—";
  const callSpeaker = s(attached, "sinkLabel") || s(spk, "label") || s(micAuto, "speakerLabel") || "System default";
  const splitDevices = callMic !== "—" && callSpeaker && !callSpeaker.toLowerCase().includes("default") && callMic.toLowerCase().split(" ")[0] !== callSpeaker.toLowerCase().split(" ")[0];
  const defaultSpeaker = /system default/i.test(callSpeaker);

  const Row = ({ label, value, warn }: { label: string; value: string; warn?: boolean }) => (
    <div style={{ display: "flex", gap: 10, fontSize: 12, padding: "3px 0" }}>
      <span style={{ width: 150, color: "#64748b", flexShrink: 0 }}>{label}</span>
      <span style={{ color: warn ? "#fca5a5" : "#e2e8f0", wordBreak: "break-word" }}>{value}</span>
    </div>
  );

  const verdict = lastTrace(events, "verdict");
  const vCode = s(verdict, "code");
  const vTone = VERDICT_BAD.has(vCode) ? "#dc2626" : VERDICT_WARN.has(vCode) ? "#f59e0b" : vCode === "ok" ? "#16a34a" : "#64748b";
  const vEvidence = Array.isArray(verdict?.evidence) ? (verdict!.evidence as unknown[]).map(String) : [];
  const shell = lastTrace(events, "shell_info");
  const nSamples = countTrace(events, "media_sample");

  return (
    <div style={{ background: "#0f172a", border: `1px solid ${nSpkFail || nOneWay || nBlocked || nMicFail ? "#7f1d1d" : "#1e3a5f"}`, borderRadius: 10, padding: 16, marginBottom: 16 }}>
      {verdict && (
        <div style={{ marginBottom: 12, padding: "10px 12px", background: "#111827", borderRadius: 8, borderLeft: `4px solid ${vTone}` }}>
          <div style={{ fontSize: 11, letterSpacing: 0.6, color: vTone, fontWeight: 700, textTransform: "uppercase" }}>Last call verdict · {vCode}</div>
          <div style={{ fontSize: 14, color: "#f1f5f9", fontWeight: 600, marginTop: 2 }}>{s(verdict, "headline")}</div>
          {vEvidence.length > 0 && (
            <ul style={{ margin: "6px 0 0 0", paddingLeft: 18, fontSize: 12, color: "#cbd5e1" }}>
              {vEvidence.map((l, i) => <li key={i}>{l}</li>)}
            </ul>
          )}
        </div>
      )}
      <div style={{ color: "#93c5fd", fontWeight: 700, fontSize: 14, marginBottom: 8 }}>🎧 Devices & audio — what the app itself recorded{shell ? <span style={{ color: "#64748b", fontWeight: 400, fontSize: 12 }}> · desktop app {s(shell, "version")} on {s(shell, "os")}</span> : null}{nSamples ? <span style={{ color: "#64748b", fontWeight: 400, fontSize: 12 }}> · {nSamples} media samples</span> : null}</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 24px" }}>
        <div>
          <Row label="Microphone on last call" value={callMic} />
          <Row label="Speaker on last call" value={callSpeaker} warn={defaultSpeaker && callMic !== "—"} />
          <Row label="Ringer" value={s(ringer, "label") || "System default"} />
          <Row label="Registration (client view)" value={s(reg, "state") || "—"} />
        </div>
        <div>
          <Row label="Speaker apply failures" value={String(nSpkFail)} warn={nSpkFail > 0} />
          <Row label="Mic failures" value={String(nMicFail)} warn={nMicFail > 0} />
          <Row label="No-incoming-audio detections" value={String(nOneWay)} warn={nOneWay > 0} />
          <Row label="Playback blocked" value={String(nBlocked)} warn={nBlocked > 0} />
        </div>
      </div>
      {inv && (
        <div style={{ marginTop: 8, fontSize: 12, color: "#9ca3af" }}>
          <div><span style={{ color: "#64748b" }}>Mics seen: </span>{devList(inv.inputs)}</div>
          <div><span style={{ color: "#64748b" }}>Speakers seen: </span>{devList(inv.outputs)}</div>
        </div>
      )}
      {(splitDevices || defaultSpeaker) && callMic !== "—" && (
        <div style={{ marginTop: 10, padding: "8px 10px", background: "#1f2937", borderRadius: 6, borderLeft: "3px solid #f59e0b", fontSize: 12, color: "#fde68a" }}>
          Mic and speaker are on DIFFERENT devices ({callMic} / {callSpeaker}). This is the "caller hears me, I don't hear them" shape: the app auto-pairs the mic to a headset but the speaker stays on the Windows default until it is picked explicitly. For a Bluetooth headset, pick its <b>Hands-Free</b> entry for both.
        </div>
      )}
      {spkFail && (
        <div style={{ marginTop: 8, padding: "8px 10px", background: "#1f2937", borderRadius: 6, borderLeft: "3px solid #dc2626", fontSize: 12, color: "#fca5a5" }}>
          Last speaker failure: "{s(spkFail, "label")}" — {s(spkFail, "error")} ({s(spkFail, "why")}). The settings still show that device while the call audio plays on the Windows default output.
        </div>
      )}
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function CallTimelinePage() {
  const [search, setSearch] = useState("");
  const [sessions, setSessions] = useState<TimelineSession[]>([]);
  const [selected, setSelected] = useState<TimelineSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function doSearch() {
    if (!search.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const q = encodeURIComponent(search.trim());
      const res = await apiGet<{ sessions: TimelineSession[] }>(`/admin/voice/diag/timeline?q=${q}`);
      setSessions(res.sessions);
      if (res.sessions.length === 1) setSelected(res.sessions[0]);
      else setSelected(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed");
    } finally {
      setLoading(false);
    }
  }

  const qualityReport = selected?.events.find(e => e.type === "CALL_QUALITY_REPORT");
  const grade = qualityReport ? String(qualityReport.payload.qualityGrade ?? "") : null;

  return (
    <PermissionGate permission="can_manage_global_settings">
      <div style={{ padding: "24px 32px", maxWidth: 1100, margin: "0 auto" }}>
        <PageHeader
          title="Call Timeline"
          subtitle="Look up any session by email, user ID, or session ID and see the full event timeline with AI diagnosis."
        />

        {/* Search bar */}
        <div style={{ display: "flex", gap: 10, marginTop: 24, marginBottom: 20 }}>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => e.key === "Enter" && doSearch()}
            placeholder="Search by email, user ID, or session ID…"
            style={{
              flex: 1, background: "#1f2937", border: "1px solid #374151", borderRadius: 8,
              color: "#f1f5f9", padding: "10px 14px", fontSize: 14, outline: "none",
            }}
          />
          <button onClick={doSearch} disabled={loading} style={{
            background: "#2563eb", color: "#fff", border: "none", borderRadius: 8,
            padding: "10px 22px", fontWeight: 600, fontSize: 14,
            cursor: loading ? "default" : "pointer", opacity: loading ? 0.6 : 1,
          }}>
            {loading ? "Searching…" : "Search"}
          </button>
        </div>

        {error && (
          <div style={{ background: "#7f1d1d", border: "1px solid #991b1b", borderRadius: 8, padding: "10px 14px", color: "#fca5a5", marginBottom: 16, fontSize: 13 }}>
            {error}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: sessions.length > 1 ? "260px 1fr" : "1fr", gap: 20 }}>

          {/* Session list (when multiple results) */}
          {sessions.length > 1 && (
            <div>
              <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>{sessions.length} sessions found</div>
              {sessions.map(s => (
                <div key={s.id} onClick={() => setSelected(s)}
                  style={{
                    padding: "10px 12px", borderRadius: 8, cursor: "pointer", marginBottom: 6,
                    background: selected?.id === s.id ? "#1e3a5f" : "#1f2937",
                    border: `1px solid ${selected?.id === s.id ? "#2563eb" : "#374151"}`,
                  }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#e2e8f0" }}>{s.userEmail}</div>
                  <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>
                    {s.platform} · {new Date(s.startedAt).toLocaleDateString()} {fmt(s.startedAt)}
                  </div>
                  <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                    <span style={{ fontSize: 10, padding: "1px 5px", borderRadius: 3, background: s.iceHasTurn ? "#14532d" : "#7f1d1d", color: s.iceHasTurn ? "#86efac" : "#fca5a5" }}>
                      {s.iceHasTurn ? "TURN" : "NO TURN"}
                    </span>
                    <span style={{ fontSize: 10, padding: "1px 5px", borderRadius: 3, background: "#1f2937", color: "#9ca3af" }}>
                      {s.events.length} events
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Timeline view */}
          {selected && (
            <div>
              {/* Session header */}
              <div style={{ background: "#1f2937", border: "1px solid #374151", borderRadius: 10, padding: 16, marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                  <div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: "#f1f5f9" }}>{selected.userEmail}</div>
                    <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
                      Session {selected.id.slice(0, 12)}… · {selected.platform} · {new Date(selected.startedAt).toLocaleString()}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
                    <span style={{ fontSize: 12, padding: "4px 10px", borderRadius: 6, background: selected.iceHasTurn ? "#14532d" : "#7f1d1d", color: selected.iceHasTurn ? "#86efac" : "#fca5a5", fontWeight: 700 }}>
                      {selected.iceHasTurn ? "✓ TURN configured" : "✗ No TURN"}
                    </span>
                    {grade && (
                      <span style={{ fontSize: 12, padding: "4px 10px", borderRadius: 6, background: gradeColor(grade) + "22", color: gradeColor(grade), fontWeight: 700 }}>
                        Quality: {grade.toUpperCase()}
                      </span>
                    )}
                    <span style={{ fontSize: 12, padding: "4px 10px", borderRadius: 6, background: "#111827", color: "#9ca3af" }}>
                      {selected.events.length} events
                    </span>
                  </div>
                </div>
              </div>

              {/* Devices & audio — the client trace, summarised */}
              <DevicesCard events={selected.events} />

              {/* AI explanation */}
              <AiExplainPanel sessionId={selected.id} tenantId={undefined} />

              {/* Event timeline */}
              <div style={{ marginTop: 20 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#9ca3af", marginBottom: 10 }}>EVENT TIMELINE</div>
                {selected.events.length === 0 ? (
                  <div style={{ color: "#6b7280", fontSize: 13 }}>No events recorded for this session.</div>
                ) : (
                  <div style={{ background: "#1f2937", borderRadius: 10, padding: "12px 16px" }}>
                    {selected.events.map(ev => (
                      <EventDetail key={ev.id} event={ev} sessionStart={selected.startedAt} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {!selected && sessions.length === 0 && !loading && (
            <div style={{ color: "#4b5563", fontSize: 14, textAlign: "center", padding: "60px 0" }}>
              Search by email or session ID to see the call timeline.
            </div>
          )}
        </div>
      </div>
    </PermissionGate>
  );
}
