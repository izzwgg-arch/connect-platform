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
};

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
  const icon = EVENT_ICONS[event.type] ?? "•";
  const color = EVENT_COLORS[event.type] ?? "#6b7280";
  const p = event.payload;
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
            {icon} {event.type.replace(/_/g, " ")}
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
