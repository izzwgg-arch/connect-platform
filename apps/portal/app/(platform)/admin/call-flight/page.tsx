"use client";

import { useState, useEffect, useCallback } from "react";
import { PageHeader } from "../../../../components/PageHeader";
import { PermissionGate } from "../../../../components/PermissionGate";
import { apiGet, apiPost } from "../../../../services/apiClient";

// ── Types ────────────────────────────────────────────────────────────────────

interface FlightEvent {
  seq: number;
  ts: string;
  tsMs: number;
  category: string;
  stage: string;
  appState: string;
  screen?: string | null;
  sipState?: string | null;
  audioState?: string | null;
  severity: "info" | "warn" | "error";
  inviteId?: string | null;
  pbxCallId?: string | null;
  payload?: Record<string, unknown>;
}

interface FlightSession {
  id: string;
  inviteId: string | null;
  pbxCallId: string | null;
  linkedId: string | null;
  tenantId: string | null;
  userId: string | null;
  extension: string | null;
  fromNumber: string | null;
  platform: string;
  appVersion: string | null;
  result: string | null;
  uiMode: string | null;
  startedAt: string;
  endedAt: string | null;
  uploadedAt: string;
  hadRingtone: boolean;
  hadBlankScreen: boolean;
  hadAppRestart: boolean;
  hadFullScreen: boolean;
  answerDelayMs: number | null;
  sipConnectMs: number | null;
  pushToUiMs: number | null;
  warningFlags: string[];
  aiSummary: FlightExplain | null;
  events?: FlightEvent[];
}

interface FlightExplain {
  summary: string;
  whatHappened: string;
  likelyCause: string;
  suggestedFix: string;
  confidence: string;
  grade: string | null;
  warnings: string[];
  timeline: string;
}

interface StatsData {
  total: number;
  answered: number;
  failed: number;
  missed: number;
  withWarnings: number;
  withBlank: number;
  withRestart: number;
  since: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const CATEGORY_COLORS: Record<string, string> = {
  PUSH: "#3b82f6",
  APP: "#8b5cf6",
  UI: "#06b6d4",
  USER: "#22c55e",
  AUDIO: "#f59e0b",
  SIP: "#10b981",
  NATIVE: "#6366f1",
  NETWORK: "#64748b",
  BACKEND: "#ec4899",
  SYSTEM: "#6b7280",
};

const RESULT_CONFIG: Record<string, { color: string; bg: string; label: string }> = {
  answered: { color: "#22c55e", bg: "#14532d22", label: "Answered" },
  declined: { color: "#6b7280", bg: "#1f293722", label: "Declined" },
  failed: { color: "#ef4444", bg: "#7f1d1d22", label: "Failed" },
  missed: { color: "#f59e0b", bg: "#78350f22", label: "Missed" },
  ended: { color: "#60a5fa", bg: "#1e3a5f22", label: "Ended" },
  unknown: { color: "#4b5563", bg: "#11182722", label: "Unknown" },
};

const STAGE_ICONS: Record<string, string> = {
  PUSH_RECEIVED_BG: "📨",
  PUSH_RECEIVED_FG: "📬",
  INCOMING_SCREEN_SHOWN: "📱",
  FULL_SCREEN_INCOMING_SHOWN: "🖥",
  FLOATING_BANNER_SHOWN: "🔔",
  ANSWER_TAPPED: "✅",
  DECLINE_TAPPED: "❌",
  HANGUP_TAPPED: "📴",
  RINGTONE_START: "🎵",
  RINGTONE_STOP: "🔇",
  SIP_REGISTERED: "🔐",
  SIP_REGISTER_FAILED: "🔴",
  SIP_ANSWER_START: "📞",
  SIP_ANSWER_SENT: "➡️",
  SIP_CONNECTED: "🟢",
  SIP_ANSWER_FAILED: "🔴",
  CALL_ENDED: "📵",
  ACTIVE_CALL_SCREEN_SHOWN: "🎤",
  CALL_ENDED_SCREEN_SHOWN: "⏹",
  BLANK_SCREEN_DETECTED: "⬜",
  APP_REMOUNT_DETECTED: "🔄",
  PBX_CALL_ANSWERED: "✅",
  PBX_ANSWER_DESYNC: "⚠️",
};

function fmtMs(v: number | null): string {
  if (v === null || v === undefined) return "—";
  if (v < 1000) return `${v}ms`;
  return `${(v / 1000).toFixed(1)}s`;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    fractionalSecondDigits: 3, hour12: false,
  });
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function elapsed(startMs: number, tsMs: number): string {
  const d = tsMs - startMs;
  if (d < 0) return "";
  if (d < 1000) return `+${d}ms`;
  return `+${(d / 1000).toFixed(2)}s`;
}

function gradeBadge(grade: string | null) {
  if (!grade) return null;
  const map: Record<string, string> = {
    good: "#22c55e", fair: "#f59e0b", poor: "#ef4444",
  };
  const col = map[grade] ?? "#6b7280";
  return (
    <span style={{
      display: "inline-block", padding: "2px 8px", borderRadius: 4,
      background: col + "22", color: col, fontWeight: 700, fontSize: 11,
    }}>
      {grade.toUpperCase()}
    </span>
  );
}

// ── Warning flags chip list ───────────────────────────────────────────────────

function WarningChips({ flags }: { flags: string[] }) {
  if (!flags.length) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
      {flags.map(f => (
        <span key={f} style={{
          fontSize: 10, padding: "2px 6px", borderRadius: 4,
          background: "#7f1d1d44", color: "#fca5a5", fontWeight: 600,
        }}>
          ⚠ {f.replace(/_/g, " ")}
        </span>
      ))}
    </div>
  );
}

// ── Stats header ──────────────────────────────────────────────────────────────

function StatsHeader({ stats }: { stats: StatsData }) {
  const cards = [
    { label: "Total calls", value: stats.total, color: "#60a5fa" },
    { label: "Answered", value: stats.answered, color: "#22c55e" },
    { label: "Failed", value: stats.failed, color: "#ef4444" },
    { label: "Missed", value: stats.missed, color: "#f59e0b" },
    { label: "With warnings", value: stats.withWarnings, color: "#f59e0b" },
    { label: "Blank screen", value: stats.withBlank, color: "#ef4444" },
    { label: "App restart", value: stats.withRestart, color: "#ef4444" },
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 10, marginBottom: 24 }}>
      {cards.map(c => (
        <div key={c.label} style={{
          background: "#1f2937", border: "1px solid #374151", borderRadius: 8, padding: "12px 14px",
        }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: c.color }}>{c.value}</div>
          <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>{c.label}</div>
        </div>
      ))}
    </div>
  );
}

// ── Timeline event row ────────────────────────────────────────────────────────

function EventRow({ event, startMs }: { event: FlightEvent; startMs: number }) {
  const [open, setOpen] = useState(false);
  const catColor = CATEGORY_COLORS[event.category] ?? "#6b7280";
  const icon = STAGE_ICONS[event.stage] ?? "•";
  const isError = event.severity === "error";
  const isWarn = event.severity === "warn";
  const rowBg = isError ? "#7f1d1d11" : isWarn ? "#78350f11" : "transparent";
  const stageColor = isError ? "#f87171" : isWarn ? "#fbbf24" : "#e2e8f0";

  return (
    <div
      onClick={() => setOpen(o => !o)}
      style={{
        display: "flex", gap: 12, padding: "6px 8px", borderBottom: "1px solid #1f2937",
        cursor: "pointer", background: rowBg,
      }}
    >
      {/* Dot + line */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 20, flexShrink: 0 }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: catColor, marginTop: 5, flexShrink: 0 }} />
        <div style={{ flex: 1, width: 1, background: "#374151" }} />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Header row */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 10, padding: "1px 5px", borderRadius: 3, background: catColor + "22", color: catColor, fontWeight: 600 }}>
            {event.category}
          </span>
          <span style={{ fontSize: 13, fontWeight: 600, color: stageColor }}>
            {icon} {event.stage.replace(/_/g, " ")}
          </span>
          {event.screen && (
            <span style={{ fontSize: 10, color: "#4b5563" }}>
              on {event.screen}
            </span>
          )}
          <span style={{ fontSize: 11, color: "#4b5563", marginLeft: "auto", flexShrink: 0 }}>
            {fmtTime(event.ts)}
            <span style={{ marginLeft: 6, color: "#374151" }}>{elapsed(startMs, event.tsMs)}</span>
          </span>
        </div>

        {/* State tags */}
        <div style={{ display: "flex", gap: 6, marginTop: 3, flexWrap: "wrap" }}>
          {event.appState && event.appState !== "active" && (
            <span style={{ fontSize: 10, color: "#6b7280" }}>app:{event.appState}</span>
          )}
          {event.sipState && (
            <span style={{ fontSize: 10, color: "#4b5563" }}>sip:{event.sipState}</span>
          )}
          {event.audioState && (
            <span style={{ fontSize: 10, color: "#4b5563" }}>audio:{event.audioState}</span>
          )}
        </div>

        {/* Payload */}
        {open && event.payload && Object.keys(event.payload).length > 0 && (
          <pre style={{
            fontSize: 11, color: "#9ca3af", background: "#111827", padding: 8, borderRadius: 6,
            marginTop: 6, overflowX: "auto", maxHeight: 180,
          }}>
            {JSON.stringify(event.payload, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

// ── AI Explain panel ──────────────────────────────────────────────────────────

function AiPanel({ session }: { session: FlightSession }) {
  const [explain, setExplain] = useState<FlightExplain | null>(session.aiSummary);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiPost<FlightExplain>(
        `/admin/call-flight/sessions/${session.id}/explain`,
        {},
      );
      setExplain(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      background: "#0f172a", border: "1px solid #1e3a5f", borderRadius: 10, padding: 16, marginBottom: 20,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <span style={{ color: "#93c5fd", fontWeight: 700, fontSize: 14 }}>🤖 AI Diagnosis</span>
        <button onClick={load} disabled={loading} style={{
          background: "#1d4ed8", color: "#fff", border: "none", borderRadius: 6,
          padding: "6px 14px", fontSize: 12, cursor: loading ? "default" : "pointer",
          opacity: loading ? 0.6 : 1,
        }}>
          {loading ? "Analyzing…" : explain ? "Re-analyze" : "Explain this call"}
        </button>
      </div>

      {error && <div style={{ color: "#f87171", fontSize: 12 }}>{error}</div>}

      {explain && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {/* Timeline string */}
          {explain.timeline && (
            <div style={{
              fontSize: 11, color: "#60a5fa", background: "#1e293b", padding: "6px 10px",
              borderRadius: 6, borderLeft: "3px solid #3b82f6", fontFamily: "monospace",
            }}>
              {explain.timeline}
            </div>
          )}

          {/* Summary headline */}
          <div style={{ fontSize: 15, fontWeight: 700, color: "#e2e8f0" }}>
            {gradeBadge(explain.grade)}
            {explain.grade && " "}
            {explain.summary}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            {[
              { label: "What happened", text: explain.whatHappened, color: "#cbd5e1" },
              { label: "Likely cause", text: explain.likelyCause, color: "#fbbf24" },
              { label: "Suggested fix", text: explain.suggestedFix, color: "#86efac" },
            ].map(b => (
              <div key={b.label} style={{ background: "#1e293b", borderRadius: 8, padding: 12 }}>
                <div style={{ fontSize: 10, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>
                  {b.label}
                </div>
                <div style={{ fontSize: 12, color: b.color, lineHeight: 1.5 }}>{b.text}</div>
              </div>
            ))}
          </div>

          {explain.warnings.length > 0 && (
            <div>
              <div style={{ fontSize: 10, color: "#6b7280", textTransform: "uppercase", marginBottom: 4 }}>Detected warnings</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {explain.warnings.map(w => (
                  <span key={w} style={{
                    fontSize: 11, padding: "2px 7px", borderRadius: 4,
                    background: "#7f1d1d44", color: "#fca5a5", fontWeight: 600,
                  }}>
                    ⚠ {w.replace(/_/g, " ")}
                  </span>
                ))}
              </div>
            </div>
          )}
          <div style={{ fontSize: 10, color: "#374151" }}>Confidence: {explain.confidence}</div>
        </div>
      )}
    </div>
  );
}

// ── State panels ──────────────────────────────────────────────────────────────

function StatePanels({ session }: { session: FlightSession }) {
  const panels = [
    {
      label: "Call Result",
      value: session.result ?? "unknown",
      color: (RESULT_CONFIG[session.result ?? "unknown"] ?? RESULT_CONFIG.unknown).color,
    },
    { label: "UI Mode", value: session.uiMode ?? "—", color: "#60a5fa" },
    { label: "Push → UI", value: fmtMs(session.pushToUiMs), color: session.pushToUiMs && session.pushToUiMs > 5000 ? "#ef4444" : "#22c55e" },
    { label: "Answer delay", value: fmtMs(session.answerDelayMs), color: session.answerDelayMs && session.answerDelayMs > 3000 ? "#f59e0b" : "#22c55e" },
    { label: "SIP connect", value: fmtMs(session.sipConnectMs), color: session.sipConnectMs && session.sipConnectMs > 5000 ? "#ef4444" : "#22c55e" },
    { label: "Ringtone", value: session.hadRingtone ? "✓ Yes" : "✗ No", color: session.hadRingtone ? "#22c55e" : "#ef4444" },
    { label: "Full screen", value: session.hadFullScreen ? "✓ Yes" : "—", color: session.hadFullScreen ? "#22c55e" : "#6b7280" },
    { label: "Blank screen", value: session.hadBlankScreen ? "⚠ Yes" : "—", color: session.hadBlankScreen ? "#ef4444" : "#22c55e" },
    { label: "App restart", value: session.hadAppRestart ? "⚠ Yes" : "—", color: session.hadAppRestart ? "#ef4444" : "#22c55e" },
    { label: "Platform", value: session.platform, color: "#9ca3af" },
    { label: "App version", value: session.appVersion ?? "—", color: "#9ca3af" },
  ];

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 8, marginBottom: 20 }}>
      {panels.map(p => (
        <div key={p.label} style={{
          background: "#1f2937", border: "1px solid #374151", borderRadius: 8, padding: "10px 12px",
        }}>
          <div style={{ fontSize: 10, color: "#4b5563", textTransform: "uppercase", marginBottom: 2 }}>{p.label}</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: p.color }}>{p.value}</div>
        </div>
      ))}
    </div>
  );
}

// ── Session list item ─────────────────────────────────────────────────────────

function SessionItem({
  session, selected, onSelect,
}: {
  session: FlightSession;
  selected: boolean;
  onSelect: () => void;
}) {
  const rc = RESULT_CONFIG[session.result ?? "unknown"] ?? RESULT_CONFIG.unknown;
  return (
    <div
      onClick={onSelect}
      style={{
        padding: "10px 12px", borderRadius: 8, cursor: "pointer", marginBottom: 6,
        background: selected ? "#1e3a5f" : "#1f2937",
        border: `1px solid ${selected ? "#2563eb" : "#374151"}`,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: rc.color }}>
          {rc.label}
        </div>
        <div style={{ fontSize: 10, color: "#4b5563" }}>{fmtDate(session.uploadedAt)}</div>
      </div>
      <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>
        {session.inviteId ? `invite: ${session.inviteId.slice(0, 16)}…` : "no inviteId"}
        {session.fromNumber ? ` · ${session.fromNumber}` : ""}
      </div>
      <div style={{ fontSize: 10, color: "#4b5563", marginTop: 2 }}>
        {session.platform} {session.appVersion ? `v${session.appVersion}` : ""} {session.extension ? `· ext ${session.extension}` : ""}
      </div>
      <WarningChips flags={session.warningFlags} />
    </div>
  );
}

// ── Full session detail panel ─────────────────────────────────────────────────

function SessionDetail({ sessionId }: { sessionId: string }) {
  const [session, setSession] = useState<(FlightSession & { events: FlightEvent[] }) | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet<{ session: FlightSession & { events: FlightEvent[] } }>(
        `/admin/call-flight/sessions/${sessionId}`,
      );
      setSession(res.session);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <div style={{ color: "#6b7280", padding: 20 }}>Loading session…</div>;
  if (error) return <div style={{ color: "#f87171", padding: 20 }}>{error}</div>;
  if (!session) return null;

  const events: FlightEvent[] = Array.isArray(session.events) ? session.events : [];
  const startMs = new Date(session.startedAt).getTime();

  const cats = Array.from(new Set(events.map(e => e.category)));
  const filtered = filter
    ? events.filter(e => e.category === filter || e.stage.toLowerCase().includes(filter.toLowerCase()))
    : events;

  // Group by category for the overview
  const grouped = cats.reduce<Record<string, FlightEvent[]>>((acc, cat) => {
    acc[cat] = events.filter(e => e.category === cat);
    return acc;
  }, {});

  return (
    <div>
      {/* Session identity header */}
      <div style={{
        background: "#1f2937", border: "1px solid #374151", borderRadius: 10, padding: 16, marginBottom: 16,
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#f1f5f9" }}>
              {session.inviteId ? `Invite: ${session.inviteId}` : `Session: ${session.id.slice(0, 16)}…`}
            </div>
            <div style={{ fontSize: 11, color: "#6b7280", marginTop: 4 }}>
              {session.fromNumber ? `From: ${session.fromNumber}` : ""}
              {session.extension ? ` → ext ${session.extension}` : ""}
              {session.pbxCallId ? ` · PBX: ${session.pbxCallId}` : ""}
              {session.linkedId ? ` · linked: ${session.linkedId}` : ""}
            </div>
            <div style={{ fontSize: 11, color: "#4b5563", marginTop: 2 }}>
              {fmtDate(session.startedAt)}
              {session.endedAt ? ` → ${fmtDate(session.endedAt)}` : " (no end time)"}
              {" · "}{session.userId ?? "no userId"}
              {session.tenantId ? ` · tenant: ${session.tenantId.slice(0, 12)}…` : ""}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
            <span style={{
              padding: "3px 10px", borderRadius: 6, fontWeight: 700, fontSize: 12,
              ...((RESULT_CONFIG[session.result ?? "unknown"] ?? RESULT_CONFIG.unknown) as any),
            }}>
              {(RESULT_CONFIG[session.result ?? "unknown"] ?? RESULT_CONFIG.unknown).label}
            </span>
            <span style={{ fontSize: 11, color: "#4b5563" }}>{events.length} events</span>
          </div>
        </div>
        <WarningChips flags={session.warningFlags} />
      </div>

      {/* State panels */}
      <StatePanels session={session} />

      {/* AI Diagnosis */}
      <AiPanel session={session} />

      {/* Category overview */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", marginBottom: 8 }}>
          Coverage by category
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {cats.map(cat => (
            <button
              key={cat}
              onClick={() => setFilter(f => f === cat ? "" : cat)}
              style={{
                padding: "3px 10px", borderRadius: 6, fontSize: 11, cursor: "pointer",
                border: `1px solid ${CATEGORY_COLORS[cat] ?? "#4b5563"}`,
                background: filter === cat ? (CATEGORY_COLORS[cat] ?? "#4b5563") + "33" : "transparent",
                color: CATEGORY_COLORS[cat] ?? "#9ca3af", fontWeight: 600,
              }}
            >
              {cat} <span style={{ opacity: 0.7 }}>({grouped[cat].length})</span>
            </button>
          ))}
          {filter && (
            <button onClick={() => setFilter("")} style={{
              padding: "3px 10px", borderRadius: 6, fontSize: 11, cursor: "pointer",
              border: "1px solid #374151", background: "transparent", color: "#6b7280",
            }}>
              Clear filter
            </button>
          )}
        </div>
      </div>

      {/* Event timeline */}
      <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>
        Event timeline {filter ? `(${filtered.length} / ${events.length})` : `(${events.length})`}
      </div>
      <div style={{ background: "#1f2937", borderRadius: 10, padding: "8px 12px", maxHeight: 600, overflowY: "auto" }}>
        {filtered.length === 0 ? (
          <div style={{ color: "#4b5563", fontSize: 13, padding: "20px 0" }}>No events match the filter.</div>
        ) : (
          filtered.map(ev => (
            <EventRow key={`${ev.seq}-${ev.ts}`} event={ev} startMs={startMs} />
          ))
        )}
      </div>
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function CallFlightPage() {
  const [search, setSearch] = useState("");
  const [resultFilter, setResultFilter] = useState("");
  const [sessions, setSessions] = useState<FlightSession[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<StatsData | null>(null);
  const [offset, setOffset] = useState(0);
  const LIMIT = 30;

  const loadStats = useCallback(async () => {
    try {
      const s = await apiGet<StatsData>("/admin/call-flight/stats");
      setStats(s);
    } catch {
      // Non-fatal
    }
  }, []);

  const doSearch = useCallback(async (newOffset = 0) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set("q", search.trim());
      if (resultFilter) params.set("result", resultFilter);
      params.set("limit", String(LIMIT));
      params.set("offset", String(newOffset));

      const res = await apiGet<{ sessions: FlightSession[]; total: number }>(
        `/admin/call-flight/sessions?${params}`,
      );
      setSessions(res.sessions);
      setTotal(res.total);
      setOffset(newOffset);
      if (res.sessions.length === 1) setSelected(res.sessions[0].id);
      else if (newOffset === 0) setSelected(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed");
    } finally {
      setLoading(false);
    }
  }, [search, resultFilter]);

  useEffect(() => {
    void loadStats();
    void doSearch(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <PermissionGate permission="can_manage_global_settings">
      <div style={{ padding: "24px 32px", maxWidth: 1400, margin: "0 auto" }}>
        <PageHeader
          title="Call Flight Recorder"
          subtitle="Full structured event timeline for every mobile call — search by invite ID, PBX call ID, extension, or phone number."
        />

        {stats && <StatsHeader stats={stats} />}

        {/* Search + filters */}
        <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => e.key === "Enter" && doSearch(0)}
            placeholder="Search by invite ID, PBX ID, phone, extension, user ID…"
            style={{
              flex: 1, minWidth: 260, background: "#1f2937", border: "1px solid #374151",
              borderRadius: 8, color: "#f1f5f9", padding: "10px 14px", fontSize: 13, outline: "none",
            }}
          />
          <select
            value={resultFilter}
            onChange={e => { setResultFilter(e.target.value); }}
            style={{
              background: "#1f2937", border: "1px solid #374151", borderRadius: 8,
              color: "#f1f5f9", padding: "10px 12px", fontSize: 13, outline: "none",
            }}
          >
            <option value="">All results</option>
            {Object.entries(RESULT_CONFIG).map(([k, v]) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
          </select>
          <button
            onClick={() => doSearch(0)}
            disabled={loading}
            style={{
              background: "#2563eb", color: "#fff", border: "none", borderRadius: 8,
              padding: "10px 20px", fontWeight: 600, fontSize: 13,
              cursor: loading ? "default" : "pointer", opacity: loading ? 0.6 : 1,
            }}
          >
            {loading ? "Searching…" : "Search"}
          </button>
        </div>

        {error && (
          <div style={{
            background: "#7f1d1d", border: "1px solid #991b1b", borderRadius: 8,
            padding: "10px 14px", color: "#fca5a5", marginBottom: 16, fontSize: 13,
          }}>
            {error}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 20, alignItems: "flex-start" }}>
          {/* Session list */}
          <div>
            <div style={{ fontSize: 11, color: "#4b5563", marginBottom: 8 }}>
              {total > 0 ? `${total} calls found` : "No calls found"}
            </div>
            <div style={{ maxHeight: "calc(100vh - 360px)", overflowY: "auto" }}>
              {sessions.map(s => (
                <SessionItem
                  key={s.id}
                  session={s}
                  selected={selected === s.id}
                  onSelect={() => setSelected(s.id)}
                />
              ))}
            </div>
            {/* Pagination */}
            {total > LIMIT && (
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button
                  disabled={offset === 0}
                  onClick={() => doSearch(Math.max(0, offset - LIMIT))}
                  style={{
                    flex: 1, background: "#1f2937", color: "#9ca3af", border: "1px solid #374151",
                    borderRadius: 6, padding: "6px", fontSize: 12, cursor: offset === 0 ? "default" : "pointer",
                  }}
                >
                  ← Prev
                </button>
                <button
                  disabled={offset + LIMIT >= total}
                  onClick={() => doSearch(offset + LIMIT)}
                  style={{
                    flex: 1, background: "#1f2937", color: "#9ca3af", border: "1px solid #374151",
                    borderRadius: 6, padding: "6px", fontSize: 12, cursor: offset + LIMIT >= total ? "default" : "pointer",
                  }}
                >
                  Next →
                </button>
              </div>
            )}
          </div>

          {/* Detail panel */}
          <div>
            {selected ? (
              <SessionDetail key={selected} sessionId={selected} />
            ) : (
              <div style={{ color: "#4b5563", fontSize: 14, textAlign: "center", padding: "80px 0" }}>
                Select a call from the list to see the full event timeline and AI diagnosis.
              </div>
            )}
          </div>
        </div>
      </div>
    </PermissionGate>
  );
}
