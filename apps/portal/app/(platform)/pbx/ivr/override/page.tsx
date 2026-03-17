"use client";

import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "../../../../../components/PageHeader";
import { DetailCard } from "../../../../../components/DetailCard";
import { EmptyState } from "../../../../../components/EmptyState";
import { LoadingSkeleton } from "../../../../../components/LoadingSkeleton";
import { ErrorState } from "../../../../../components/ErrorState";
import { StatusChip } from "../../../../../components/StatusChip";
import { useAsyncResource } from "../../../../../hooks/useAsyncResource";
import { apiGet, apiPost, apiDelete } from "../../../../../services/apiClient";

// ── Types ────────────────────────────────────────────────────────────────────

interface IvrSchedule {
  id: string;
  ivrId: string;
  ivrName: string;
  recordingId?: string;
  recordingName?: string;
  startTime: string; // ISO
  endTime: string;   // ISO
  enabled: boolean;
  status: "scheduled" | "active" | "expired";
  createdAt: string;
}

interface IvrOption {
  id: string;
  name: string;
}

interface RecordingOption {
  id: string;
  name: string;
}

function scheduleStatus(s: IvrSchedule): IvrSchedule["status"] {
  const now = Date.now();
  const start = new Date(s.startTime).getTime();
  const end = new Date(s.endTime).getTime();
  if (!s.enabled || now > end) return "expired";
  if (now >= start && now <= end) return "active";
  return "scheduled";
}

function toLocalDatetimeInput(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalDatetimeInput(value: string): string {
  if (!value) return "";
  return new Date(value).toISOString();
}

function roundToNextHour(): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return toLocalDatetimeInput(d.toISOString());
}

function roundToHourPlus(hours: number): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + hours);
  return toLocalDatetimeInput(d.toISOString());
}

// ── Duration shortcuts ───────────────────────────────────────────────────────

const DURATION_SHORTCUTS = [
  { label: "1 hour",   hours: 1  },
  { label: "2 hours",  hours: 2  },
  { label: "4 hours",  hours: 4  },
  { label: "8 hours",  hours: 8  },
  { label: "24 hours", hours: 24 },
];

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function IvrOverridePage() {
  const [reloadKey, setReloadKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [opMsg, setOpMsg] = useState("");

  // Form state
  const [ivrId, setIvrId] = useState("");
  const [recordingId, setRecordingId] = useState("");
  const [startTime, setStartTime] = useState(() => roundToNextHour());
  const [endTime, setEndTime] = useState(() => roundToHourPlus(2));
  const [note, setNote] = useState("");

  // Load existing schedules
  const schedulesState = useAsyncResource<{ schedules: IvrSchedule[] }>(
    () => apiGet("/pbx/ivr-schedules"),
    [reloadKey]
  );

  // Load IVR list
  const ivrState = useAsyncResource<{ rows: Record<string, unknown>[] }>(
    () => apiGet("/voice/pbx/resources/ivr"),
    []
  );

  // Load recordings list
  const recState = useAsyncResource<{ rows: Record<string, unknown>[] }>(
    () => apiGet("/voice/pbx/resources/voicemail"),
    []
  );

  const ivrs: IvrOption[] = useMemo(() => {
    if (ivrState.status !== "success") return [];
    return ivrState.data.rows.map((r, i) => ({
      id: String(r.id ?? r.uuid ?? i),
      name: String(r.name ?? r.ivr_name ?? `IVR ${i + 1}`),
    }));
  }, [ivrState]);

  const recordings: RecordingOption[] = useMemo(() => {
    if (recState.status !== "success") return [];
    return recState.data.rows.map((r, i) => ({
      id: String(r.id ?? r.uuid ?? i),
      name: String(r.name ?? r.filename ?? `Recording ${i + 1}`),
    }));
  }, [recState]);

  const schedules: IvrSchedule[] = useMemo(() => {
    if (schedulesState.status !== "success") return [];
    const raw = schedulesState.data.schedules ?? [];
    return raw.map((s) => ({ ...s, status: scheduleStatus(s) }));
  }, [schedulesState]);

  // Auto-set first IVR when list loads
  useEffect(() => {
    if (!ivrId && ivrs.length > 0) setIvrId(ivrs[0].id);
  }, [ivrs, ivrId]);

  function applyDuration(hours: number) {
    const now = new Date();
    now.setMinutes(0, 0, 0);
    setStartTime(toLocalDatetimeInput(now.toISOString()));
    const end = new Date(now);
    end.setHours(end.getHours() + hours);
    setEndTime(toLocalDatetimeInput(end.toISOString()));
  }

  async function handleCreate() {
    if (!ivrId) { setSaveError("Select an IVR to override."); return; }
    if (!startTime || !endTime) { setSaveError("Set both start and end times."); return; }
    const start = new Date(startTime);
    const end = new Date(endTime);
    if (end <= start) { setSaveError("End time must be after start time."); return; }
    setSaving(true);
    setSaveError("");
    try {
      await apiPost("/pbx/ivr-schedules", {
        ivrId,
        recordingId: recordingId || undefined,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        note: note || undefined,
      });
      setOpMsg("Override scheduled. The IVR will activate automatically at the start time.");
      setReloadKey((k) => k + 1);
      setNote("");
    } catch (err: any) {
      setSaveError(err?.message || "Failed to schedule override.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await apiDelete(`/pbx/ivr-schedules/${id}`);
      setOpMsg("Override removed.");
      setReloadKey((k) => k + 1);
    } catch (err: any) {
      setOpMsg(`Remove failed: ${err?.message}`);
    }
  }

  const statusColor = (s: IvrSchedule["status"]) =>
    s === "active" ? "success" : s === "scheduled" ? "info" : "default";

  return (
    <div className="stack compact-stack">
      <PageHeader
        title="IVR Override Scheduler"
        subtitle="Temporarily replace any IVR with a different menu or announcement. Automatically reverts when the time window expires."
      />

      {opMsg ? <div className="chip success" style={{ alignSelf: "flex-start" }}>{opMsg}</div> : null}

      {/* Create form */}
      <div className="panel stack" style={{ gap: 16 }}>
        <h3 style={{ fontSize: 15, fontWeight: 650 }}>Schedule New Override</h3>

        {/* Duration shortcuts */}
        <div>
          <label className="label">Quick Duration</label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {DURATION_SHORTCUTS.map((d) => (
              <button
                key={d.hours}
                className="btn ghost"
                style={{ fontSize: 13 }}
                onClick={() => applyDuration(d.hours)}
              >
                {d.label}
              </button>
            ))}
            <span className="muted" style={{ fontSize: 12, alignSelf: "center" }}>or set manually below</span>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label className="label">Override Start *</label>
            <input
              className="input"
              type="datetime-local"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
            />
          </div>
          <div>
            <label className="label">Override End *</label>
            <input
              className="input"
              type="datetime-local"
              value={endTime}
              min={startTime}
              onChange={(e) => setEndTime(e.target.value)}
            />
          </div>
          <div>
            <label className="label">IVR to Activate *</label>
            <select className="select" value={ivrId} onChange={(e) => setIvrId(e.target.value)}>
              <option value="">— Select IVR —</option>
              {ivrs.map((ivr) => (
                <option key={ivr.id} value={ivr.id}>{ivr.name}</option>
              ))}
            </select>
            <p className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              This IVR will be activated during the override window. All other routing stays unchanged.
            </p>
          </div>
          <div>
            <label className="label">Override Announcement (optional)</label>
            <select className="select" value={recordingId} onChange={(e) => setRecordingId(e.target.value)}>
              <option value="">— Use IVR default greeting —</option>
              {recordings.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label className="label">Internal Note (optional)</label>
            <input
              className="input"
              placeholder="e.g. Holiday closure — Christmas 2026"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>

        {saveError ? <div className="chip danger">{saveError}</div> : null}
        <div className="row-actions">
          <button className="btn" onClick={handleCreate} disabled={saving || !ivrId}>
            {saving ? "Scheduling…" : "Schedule Override"}
          </button>
        </div>
      </div>

      {/* Active and upcoming overrides */}
      <div>
        <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Active & Upcoming Overrides</h3>

        {schedulesState.status === "loading" ? <LoadingSkeleton rows={3} /> : null}
        {schedulesState.status === "error" ? (
          <ErrorState message={schedulesState.error} />
        ) : null}

        {schedulesState.status === "success" && schedules.filter(s => s.status !== "expired").length === 0 ? (
          <EmptyState
            title="No active overrides"
            message="Create an override above to temporarily replace an IVR for holidays, emergency announcements, or scheduled events."
          />
        ) : null}

        {schedulesState.status === "success" && (
          <div className="stack compact-stack">
            {schedules
              .filter((s) => s.status !== "expired")
              .map((s) => (
                <div
                  key={s.id}
                  className="panel"
                  style={{
                    padding: "14px 16px",
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    borderLeft: `3px solid var(--${s.status === "active" ? "success" : "info"})`
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span style={{ fontWeight: 650, fontSize: 14 }}>{s.ivrName}</span>
                      <StatusChip
                        label={s.status.charAt(0).toUpperCase() + s.status.slice(1)}
                        color={statusColor(s.status)}
                      />
                      {s.status === "active" ? (
                        <span className="chip success" style={{ fontSize: 11, animation: "pulse 2s infinite" }}>
                          LIVE NOW
                        </span>
                      ) : null}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
                      <span>
                        {new Date(s.startTime).toLocaleString()} → {new Date(s.endTime).toLocaleString()}
                      </span>
                      {s.recordingName ? <span> · Greeting: {s.recordingName}</span> : null}
                    </div>
                  </div>
                  <button
                    className="btn ghost"
                    style={{ fontSize: 13 }}
                    onClick={() => handleDelete(s.id)}
                  >
                    Remove
                  </button>
                </div>
              ))}
          </div>
        )}
      </div>

      {/* Expired overrides */}
      {schedulesState.status === "success" && schedules.filter(s => s.status === "expired").length > 0 ? (
        <DetailCard title="Expired Overrides (last 10)">
          <div style={{ fontSize: 13, color: "var(--text-dim)" }}>
            {schedules
              .filter((s) => s.status === "expired")
              .slice(0, 10)
              .map((s) => (
                <div key={s.id} style={{ padding: "6px 0", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between" }}>
                  <span>{s.ivrName}</span>
                  <span>{new Date(s.startTime).toLocaleString()} → {new Date(s.endTime).toLocaleString()}</span>
                </div>
              ))}
          </div>
        </DetailCard>
      ) : null}

      <DetailCard title="How IVR Overrides Work">
        <div style={{ fontSize: 13, color: "var(--text-dim)", lineHeight: 1.7 }}>
          <p>When an override is active, incoming calls that would normally reach the default IVR are routed to the override IVR instead. This is ideal for:</p>
          <ul style={{ paddingLeft: 18, marginTop: 8 }}>
            <li>Holiday closures and custom greetings</li>
            <li>Emergency announcements</li>
            <li>Scheduled after-hours routing changes</li>
            <li>Temporary call-flow adjustments without touching the main IVR</li>
          </ul>
          <p style={{ marginTop: 8 }}>The system automatically reverts to the normal routing at the end of the override window — no manual action required.</p>
        </div>
      </DetailCard>
    </div>
  );
}
