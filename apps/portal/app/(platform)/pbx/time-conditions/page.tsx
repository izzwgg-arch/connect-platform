"use client";

import { useMemo, useState } from "react";
import { EmptyState } from "../../../../components/EmptyState";
import { ErrorState } from "../../../../components/ErrorState";
import { FilterBar } from "../../../../components/FilterBar";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { PageHeader } from "../../../../components/PageHeader";
import { PermissionGate } from "../../../../components/PermissionGate";
import { SearchInput } from "../../../../components/SearchInput";
import { StatusChip } from "../../../../components/StatusChip";
import { useAsyncResource } from "../../../../hooks/useAsyncResource";
import {
  createPbxResource,
  deletePbxResource,
  loadPbxResource,
  updatePbxResource,
} from "../../../../services/pbxData";

// ── Types ─────────────────────────────────────────────────────────────────────

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DAY_ABBR = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

type TCForm = {
  name: string;
  description: string;
  timeStart: string;
  timeEnd: string;
  days: boolean[];
  destination: string;
  fallbackDestination: string;
  enabled: boolean;
};

function defaultTC(): TCForm {
  return {
    name: "",
    description: "",
    timeStart: "09:00",
    timeEnd: "17:00",
    days: [true, true, true, true, true, false, false],
    destination: "",
    fallbackDestination: "",
    enabled: true,
  };
}

function rowToTC(row: Record<string, unknown>): TCForm {
  const s = (k: string, fb = "") => String(row[k] ?? fb);
  const b = (k: string, fb = true) => {
    const v = row[k];
    if (v === undefined || v === null) return fb;
    if (typeof v === "boolean") return v;
    return String(v).toLowerCase() === "yes" || String(v).toLowerCase() === "true" || String(v) === "1";
  };

  const daysRaw = row.days;
  let days: boolean[];
  if (Array.isArray(daysRaw)) {
    days = DAYS.map((_, i) => Boolean(daysRaw[i]));
  } else if (typeof daysRaw === "string") {
    const parts = daysRaw.split(",").map((x) => x.trim().toLowerCase());
    days = DAYS.map((d) => parts.includes(d.toLowerCase().slice(0, 3)) || parts.includes(d.toLowerCase()));
  } else {
    days = [b("mon"), b("tue"), b("wed"), b("thu"), b("fri"), b("sat", false), b("sun", false)];
  }

  return {
    name: s("name"),
    description: s("description"),
    timeStart: s("timeStart") || s("start_time") || s("openTime") || "09:00",
    timeEnd: s("timeEnd") || s("end_time") || s("closeTime") || "17:00",
    days,
    destination: s("destination") || s("matchDestination"),
    fallbackDestination: s("fallbackDestination") || s("noMatchDestination") || s("afterHoursDestination"),
    enabled: b("enabled") || b("active"),
  };
}

function tcToPayload(f: TCForm): Record<string, unknown> {
  const dayNames = DAYS.filter((_, i) => f.days[i]).map((d) => d.toLowerCase().slice(0, 3));
  return {
    name: f.name,
    description: f.description,
    timeStart: f.timeStart,
    timeEnd: f.timeEnd,
    start_time: f.timeStart,
    end_time: f.timeEnd,
    openTime: f.timeStart,
    closeTime: f.timeEnd,
    days: dayNames,
    mon: f.days[0], tue: f.days[1], wed: f.days[2],
    thu: f.days[3], fri: f.days[4], sat: f.days[5], sun: f.days[6],
    destination: f.destination,
    matchDestination: f.destination,
    fallbackDestination: f.fallbackDestination,
    noMatchDestination: f.fallbackDestination,
    afterHoursDestination: f.fallbackDestination,
    enabled: f.enabled,
    active: f.enabled,
  };
}

function daysLabel(days: boolean[]): string {
  const names = days
    .map((on, i) => (on ? DAY_ABBR[i] : null))
    .filter(Boolean) as string[];
  if (names.length === 0) return "Never";
  if (names.length === 7) return "Every day";
  if (names.length === 5 && !days[5] && !days[6]) return "Mon–Fri";
  if (names.length === 2 && days[5] && days[6]) return "Weekends";
  return names.join(", ");
}

// ── Form component ────────────────────────────────────────────────────────────

function TCEditor({
  initial,
  tcId,
  onSaved,
  onCancel,
}: {
  initial: TCForm;
  tcId: string | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<TCForm>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  function set<K extends keyof TCForm>(key: K) {
    return (v: TCForm[K]) => setForm((f) => ({ ...f, [key]: v }));
  }

  function toggleDay(i: number) {
    setForm((f) => {
      const days = [...f.days];
      days[i] = !days[i];
      return { ...f, days };
    });
  }

  async function handleSave() {
    if (!form.name.trim()) {
      setError("Name is required.");
      return;
    }
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const payload = tcToPayload(form);
      if (tcId) {
        await updatePbxResource("route-selections", tcId, payload);
      } else {
        await createPbxResource("route-selections", payload);
      }
      setSuccess("Time condition saved.");
      onSaved();
    } catch (e: any) {
      setError(e?.message || "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>{tcId ? `Edit: ${form.name || "Time Condition"}` : "New Time Condition"}</h3>
        <div className="row-actions">
          <button className="btn ghost" onClick={onCancel} disabled={saving}>Cancel</button>
          <button className="btn" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <div className="form-grid">
        {/* Name + Description */}
        <div className="form-field" style={{ gridColumn: "1 / -1" }}>
          <label className="label" htmlFor="tc-name">Schedule Name</label>
          <input
            id="tc-name"
            className="input"
            value={form.name}
            onChange={(e) => set("name")(e.target.value)}
            placeholder="e.g. Business Hours, After Hours, Holiday"
          />
        </div>
        <div className="form-field" style={{ gridColumn: "1 / -1" }}>
          <label className="label" htmlFor="tc-desc">Description</label>
          <input id="tc-desc" className="input" value={form.description} onChange={(e) => set("description")(e.target.value)} placeholder="Optional notes" />
        </div>

        {/* Time range */}
        <div className="form-field">
          <label className="label" htmlFor="tc-start">Open Time</label>
          <input id="tc-start" type="time" className="input" value={form.timeStart} onChange={(e) => set("timeStart")(e.target.value)} />
        </div>
        <div className="form-field">
          <label className="label" htmlFor="tc-end">Close Time</label>
          <input id="tc-end" type="time" className="input" value={form.timeEnd} onChange={(e) => set("timeEnd")(e.target.value)} />
        </div>

        {/* Days */}
        <div className="form-field" style={{ gridColumn: "1 / -1" }}>
          <label className="label">Active Days</label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
            {DAYS.map((day, i) => (
              <button
                key={day}
                type="button"
                onClick={() => toggleDay(i)}
                className={`btn${form.days[i] ? "" : " ghost"}`}
                style={{ minWidth: 44, fontSize: 12, padding: "4px 10px" }}
              >
                {DAY_ABBR[i]}
              </button>
            ))}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Quick: {" "}
            <button type="button" className="link" onClick={() => set("days")([true, true, true, true, true, false, false])}>Mon–Fri</button>
            {" · "}
            <button type="button" className="link" onClick={() => set("days")([false, false, false, false, false, true, true])}>Weekends</button>
            {" · "}
            <button type="button" className="link" onClick={() => set("days")([true, true, true, true, true, true, true])}>Every day</button>
          </div>
        </div>

        {/* Destinations */}
        <div className="form-field" style={{ gridColumn: "1 / -1" }}>
          <label className="label" htmlFor="tc-dest">Match Destination (during hours)</label>
          <input
            id="tc-dest"
            className="input"
            value={form.destination}
            onChange={(e) => set("destination")(e.target.value)}
            placeholder="e.g. extension:101, queue:support, ivr:main-menu"
          />
          <span className="muted" style={{ fontSize: 12 }}>Where to route calls when this schedule matches</span>
        </div>
        <div className="form-field" style={{ gridColumn: "1 / -1" }}>
          <label className="label" htmlFor="tc-fallback">No-Match Destination (outside hours)</label>
          <input
            id="tc-fallback"
            className="input"
            value={form.fallbackDestination}
            onChange={(e) => set("fallbackDestination")(e.target.value)}
            placeholder="e.g. ivr:after-hours-menu, voicemail:101"
          />
          <span className="muted" style={{ fontSize: 12 }}>Where to route calls when outside this schedule</span>
        </div>

        {/* Enabled toggle */}
        <div className="form-field" style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", gap: 12 }}>
          <button
            type="button"
            role="switch"
            aria-checked={form.enabled}
            className={`btn ghost${form.enabled ? " active" : ""}`}
            style={{ minWidth: 44, padding: "4px 12px", fontSize: 12 }}
            onClick={() => set("enabled")(!form.enabled)}
          >
            {form.enabled ? "ON" : "OFF"}
          </button>
          <span style={{ fontWeight: 600, fontSize: 13 }}>
            {form.enabled ? "Schedule Active" : "Schedule Disabled"}
          </span>
        </div>
      </div>

      {success ? <div className="chip success" style={{ marginTop: 12 }}>{success}</div> : null}
      {error ? <div className="chip danger" style={{ marginTop: 12 }}>{error}</div> : null}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function TimeConditionsPage() {
  const [reloadKey, setReloadKey] = useState(0);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<{ id: string | null; form: TCForm } | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const state = useAsyncResource(() => loadPbxResource("route-selections"), ["route-selections", reloadKey]);

  const rows = useMemo(() => {
    if (state.status !== "success") return [];
    const q = query.trim().toLowerCase();
    return state.data.rows.filter((row) => {
      if (!q) return true;
      return Object.values(row).some((v) => String(v ?? "").toLowerCase().includes(q));
    });
  }, [state, query]);

  function getId(row: Record<string, unknown>, idx: number) {
    return String(row.id ?? row.uuid ?? row.name ?? idx);
  }

  return (
    <PermissionGate permission="can_view_admin" fallback={<div className="state-box">You do not have access to time conditions.</div>}>
      <div style={{ display: "flex", gap: 0, height: "100%", minHeight: 0 }}>
        {/* List */}
        <div style={{ flex: editing ? "0 0 55%" : "1 1 100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div className="stack compact-stack" style={{ paddingBottom: 12 }}>
            <PageHeader
              title="Time Conditions"
              subtitle="Define business hours, after-hours, and holiday schedules to route calls appropriately."
            />
            <FilterBar>
              <SearchInput value={query} onChange={setQuery} placeholder="Search schedules..." />
              <button className="btn ghost" onClick={() => setReloadKey((k) => k + 1)}>Refresh</button>
              <button className="btn" onClick={() => setEditing({ id: null, form: defaultTC() })}>
                + New Schedule
              </button>
            </FilterBar>
          </div>

          {deleteError ? <div className="chip danger" style={{ marginBottom: 8 }}>{deleteError}</div> : null}

          {state.status === "loading" ? <LoadingSkeleton rows={6} /> : null}
          {state.status === "error" ? <ErrorState message={state.error} /> : null}
          {state.status === "success" && rows.length === 0 ? (
            <EmptyState
              title="No time conditions found"
              message="Create a schedule to define when the office is open and route calls accordingly."
            />
          ) : null}

          {state.status === "success" && rows.length > 0 ? (
            <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
              <table className="table" style={{ width: "100%" }}>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Hours</th>
                    <th>Days</th>
                    <th>Destination</th>
                    <th>Status</th>
                    <th style={{ width: 80 }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, idx) => {
                    const id = getId(row, idx);
                    const form = rowToTC(row);
                    const isSelected = editing?.id === id;
                    return (
                      <tr
                        key={id}
                        onClick={() => setEditing({ id, form })}
                        style={{ cursor: "pointer", background: isSelected ? "var(--surface-2)" : undefined }}
                      >
                        <td style={{ fontWeight: 600 }}>{form.name || "—"}</td>
                        <td style={{ fontFamily: "monospace", fontSize: 12 }}>{form.timeStart} – {form.timeEnd}</td>
                        <td>{daysLabel(form.days)}</td>
                        <td className="muted" style={{ fontSize: 12 }}>{form.destination || "—"}</td>
                        <td>
                          <StatusChip tone={form.enabled ? "success" : "default"} label={form.enabled ? "Active" : "Disabled"} />
                        </td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <button
                            className="btn ghost danger"
                            style={{ fontSize: 12, padding: "3px 8px" }}
                            onClick={async () => {
                              setDeleteError("");
                              if (!confirm(`Delete schedule "${form.name}"?`)) return;
                              try {
                                await deletePbxResource("route-selections", id);
                                setReloadKey((k) => k + 1);
                                if (editing?.id === id) setEditing(null);
                              } catch (e: any) {
                                setDeleteError(e?.message || "Delete failed.");
                              }
                            }}
                          >
                            Del
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>

        {/* Editor */}
        {editing ? (
          <div style={{ flex: "0 0 44%", marginLeft: 16, overflowY: "auto", borderLeft: "1px solid var(--border)", paddingLeft: 16 }}>
            <TCEditor
              initial={editing.form}
              tcId={editing.id}
              onSaved={() => {
                setReloadKey((k) => k + 1);
                setEditing(null);
              }}
              onCancel={() => setEditing(null)}
            />
          </div>
        ) : null}
      </div>
    </PermissionGate>
  );
}
