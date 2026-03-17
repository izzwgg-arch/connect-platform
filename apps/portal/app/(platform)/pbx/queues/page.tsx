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
import { useTelephony } from "../../../../contexts/TelephonyContext";
import { useAsyncResource } from "../../../../hooks/useAsyncResource";
import {
  createPbxResource,
  deletePbxResource,
  loadPbxResource,
  updatePbxResource,
} from "../../../../services/pbxData";

type QueueForm = {
  name: string;
  extension: string;
  strategy: string;
  timeout: string;
  maxLen: string;
  musicClass: string;
  announceFrequency: string;
  wrapupTime: string;
  memberRingTime: string;
  agentAnnounce: string;
  enabled: boolean;
  recordCalls: boolean;
};

function defaultQueue(): QueueForm {
  return {
    name: "", extension: "", strategy: "ringall", timeout: "30", maxLen: "0",
    musicClass: "default", announceFrequency: "0", wrapupTime: "0",
    memberRingTime: "15", agentAnnounce: "", enabled: true, recordCalls: false,
  };
}

function rowToQueue(row: Record<string, unknown>): QueueForm {
  const s = (k: string, fb = "") => String(row[k] ?? fb);
  const b = (k: string, fb = false) => {
    const v = row[k];
    if (typeof v === "boolean") return v;
    if (v === undefined || v === null) return fb;
    return ["yes", "true", "1"].includes(String(v).toLowerCase());
  };
  return {
    name: s("name"),
    extension: s("extension") || s("queue"),
    strategy: s("strategy") || "ringall",
    timeout: s("timeout") || "30",
    maxLen: s("maxLen") || s("max_len") || "0",
    musicClass: s("musicClass") || s("musiconhold") || "default",
    announceFrequency: s("announceFrequency") || s("announce_frequency") || "0",
    wrapupTime: s("wrapupTime") || s("wrapuptime") || "0",
    memberRingTime: s("memberRingTime") || s("member_ring_time") || "15",
    agentAnnounce: s("agentAnnounce") || s("agent_announce"),
    enabled: b("enabled", true),
    recordCalls: b("recordCalls") || b("record"),
  };
}

function queueToPayload(f: QueueForm): Record<string, unknown> {
  return {
    name: f.name,
    extension: f.extension,
    queue: f.extension,
    strategy: f.strategy,
    timeout: Number(f.timeout) || 30,
    maxLen: Number(f.maxLen) || 0,
    max_len: Number(f.maxLen) || 0,
    musicClass: f.musicClass,
    musiconhold: f.musicClass,
    announceFrequency: Number(f.announceFrequency) || 0,
    wrapupTime: Number(f.wrapupTime) || 0,
    memberRingTime: Number(f.memberRingTime) || 15,
    agentAnnounce: f.agentAnnounce,
    enabled: f.enabled,
    recordCalls: f.recordCalls,
    record: f.recordCalls,
  };
}

const STRATEGIES = [
  { value: "ringall", label: "Ring All — ring all members simultaneously" },
  { value: "roundrobin", label: "Round Robin — rotate through members in order" },
  { value: "leastrecent", label: "Least Recent — ring member who hasn't answered the longest" },
  { value: "fewestcalls", label: "Fewest Calls — ring member with least calls" },
  { value: "random", label: "Random — ring a random member" },
  { value: "rrmemory", label: "Round Robin with Memory — remember position" },
  { value: "linear", label: "Linear — ring first available, then next" },
];

function QueueEditor({
  initial, queueId, onSaved, onCancel,
}: { initial: QueueForm; queueId: string | null; onSaved: () => void; onCancel: () => void }) {
  const [form, setForm] = useState<QueueForm>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  function set(key: keyof QueueForm) {
    return (v: string | boolean) => setForm((f) => ({ ...f, [key]: v }));
  }

  async function handleSave() {
    if (!form.name.trim()) { setError("Queue name is required."); return; }
    setSaving(true);
    setError(""); setSuccess("");
    try {
      const payload = queueToPayload(form);
      if (queueId) {
        await updatePbxResource("queues", queueId, payload);
      } else {
        await createPbxResource("queues", payload);
      }
      setSuccess("Queue saved.");
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
        <h3>{queueId ? `Edit Queue: ${form.name}` : "New Queue"}</h3>
        <div className="row-actions">
          <button className="btn ghost" onClick={onCancel} disabled={saving}>Cancel</button>
          <button className="btn" onClick={handleSave} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
      <div className="form-grid">
        <div className="form-field">
          <label className="label">Queue Name</label>
          <input className="input" value={form.name} onChange={(e) => set("name")(e.target.value)} placeholder="e.g. support" />
        </div>
        <div className="form-field">
          <label className="label">Queue Extension / Number</label>
          <input className="input" value={form.extension} onChange={(e) => set("extension")(e.target.value)} placeholder="e.g. 6001" />
        </div>
        <div className="form-field" style={{ gridColumn: "1 / -1" }}>
          <label className="label">Ring Strategy</label>
          <select className="input" value={form.strategy} onChange={(e) => set("strategy")(e.target.value)}>
            {STRATEGIES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>
        <div className="form-field">
          <label className="label">Call Timeout (sec)</label>
          <input className="input" type="number" value={form.timeout} onChange={(e) => set("timeout")(e.target.value)} />
          <span className="muted" style={{ fontSize: 12 }}>Max ring time before next agent</span>
        </div>
        <div className="form-field">
          <label className="label">Max Queue Length</label>
          <input className="input" type="number" value={form.maxLen} onChange={(e) => set("maxLen")(e.target.value)} />
          <span className="muted" style={{ fontSize: 12 }}>0 = unlimited</span>
        </div>
        <div className="form-field">
          <label className="label">Music on Hold Class</label>
          <input className="input" value={form.musicClass} onChange={(e) => set("musicClass")(e.target.value)} />
        </div>
        <div className="form-field">
          <label className="label">Wrap-up Time (sec)</label>
          <input className="input" type="number" value={form.wrapupTime} onChange={(e) => set("wrapupTime")(e.target.value)} />
          <span className="muted" style={{ fontSize: 12 }}>Pause after agent answers</span>
        </div>
        <div className="form-field">
          <label className="label">Member Ring Time (sec)</label>
          <input className="input" type="number" value={form.memberRingTime} onChange={(e) => set("memberRingTime")(e.target.value)} />
        </div>
        <div className="form-field">
          <label className="label">Announce Frequency (sec)</label>
          <input className="input" type="number" value={form.announceFrequency} onChange={(e) => set("announceFrequency")(e.target.value)} />
          <span className="muted" style={{ fontSize: 12 }}>0 = no position announce</span>
        </div>
        <div className="form-field" style={{ gridColumn: "1 / -1" }}>
          <label className="label">Agent Announcement Recording</label>
          <input className="input" value={form.agentAnnounce} onChange={(e) => set("agentAnnounce")(e.target.value)} placeholder="Recording name (optional)" />
        </div>
        <div className="form-field" style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button type="button" className={`btn ghost${form.recordCalls ? " active" : ""}`}
            style={{ minWidth: 44, padding: "4px 12px", fontSize: 12 }}
            onClick={() => set("recordCalls")(!form.recordCalls)}>
            {form.recordCalls ? "ON" : "OFF"}
          </button>
          <span style={{ fontWeight: 600, fontSize: 13 }}>Record Queue Calls</span>
        </div>
        <div className="form-field" style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button type="button" className={`btn ghost${form.enabled ? " active" : ""}`}
            style={{ minWidth: 44, padding: "4px 12px", fontSize: 12 }}
            onClick={() => set("enabled")(!form.enabled)}>
            {form.enabled ? "ON" : "OFF"}
          </button>
          <span style={{ fontWeight: 600, fontSize: 13 }}>Queue Enabled</span>
        </div>
      </div>
      {success ? <div className="chip success" style={{ marginTop: 12 }}>{success}</div> : null}
      {error ? <div className="chip danger" style={{ marginTop: 12 }}>{error}</div> : null}
    </div>
  );
}

export default function PbxQueuesPage() {
  const [reloadKey, setReloadKey] = useState(0);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<{ id: string | null; form: QueueForm } | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const state = useAsyncResource(() => loadPbxResource("queues"), ["queues", reloadKey]);
  const telephony = useTelephony();

  const rows = useMemo(() => {
    if (state.status !== "success") return [];
    const q = query.trim().toLowerCase();
    return state.data.rows.filter((row) => {
      if (!q) return true;
      return Object.values(row).some((v) => String(v ?? "").toLowerCase().includes(q));
    });
  }, [state, query]);

  const liveQueues = useMemo(() => {
    const m = new Map<string, number>();
    for (const q of telephony.queueList) {
      m.set(String(q.queueName), q.callerCount ?? 0);
    }
    return m;
  }, [telephony.queueList]);

  function getId(row: Record<string, unknown>, idx: number) {
    return String(row.id ?? row.uuid ?? row.name ?? idx);
  }

  return (
    <PermissionGate permission="can_view_calls" fallback={<div className="state-box">You do not have access to queues.</div>}>
      <div style={{ display: "flex", gap: 0, height: "100%", minHeight: 0 }}>
        <div style={{ flex: editing ? "0 0 55%" : "1 1 100%", display: "flex", flexDirection: "column" }}>
          <div className="stack compact-stack" style={{ paddingBottom: 12 }}>
            <PageHeader
              title="Call Queues"
              subtitle="Manage queue definitions, ring strategies, and agent assignments."
            />
            <FilterBar>
              <SearchInput value={query} onChange={setQuery} placeholder="Search queues..." />
              <button className="btn ghost" onClick={() => setReloadKey((k) => k + 1)}>Refresh</button>
              <button className="btn" onClick={() => setEditing({ id: null, form: defaultQueue() })}>+ New Queue</button>
            </FilterBar>
          </div>
          {deleteError ? <div className="chip danger" style={{ marginBottom: 8 }}>{deleteError}</div> : null}
          {state.status === "loading" ? <LoadingSkeleton rows={6} /> : null}
          {state.status === "error" ? (
            state.error?.includes("PBX_LINK_NOT_FOUND") ? (
              <div className="state-box">
                <strong>PBX Not Linked</strong>
                <p style={{ marginTop: 6, fontSize: 13 }}>
                  This tenant has no PBX instance configured. Link a PBX in{" "}
                  <a className="link" href="/admin/pbx">Admin → PBX Setup</a>.
                </p>
              </div>
            ) : (
              <ErrorState message={state.error} />
            )
          ) : null}
          {state.status === "success" && rows.length === 0 ? (
            <EmptyState title="No queues found" message="Create a queue to start routing calls to agent groups." />
          ) : null}
          {state.status === "success" && rows.length > 0 ? (
            <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
              <table className="table" style={{ width: "100%" }}>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Extension</th>
                    <th>Strategy</th>
                    <th>Timeout</th>
                    <th>Live Callers</th>
                    <th>Status</th>
                    <th style={{ width: 80 }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, idx) => {
                    const id = getId(row, idx);
                    const form = rowToQueue(row);
                    const callers = liveQueues.get(form.extension) ?? liveQueues.get(form.name) ?? null;
                    return (
                      <tr key={id} onClick={() => setEditing({ id, form })} style={{ cursor: "pointer", background: editing?.id === id ? "var(--surface-2)" : undefined }}>
                        <td style={{ fontWeight: 600 }}>{form.name}</td>
                        <td style={{ fontFamily: "monospace" }}>{form.extension || "—"}</td>
                        <td>{form.strategy}</td>
                        <td>{form.timeout}s</td>
                        <td>{callers !== null ? <StatusChip tone={callers > 0 ? "warning" : "success"} label={`${callers} waiting`} /> : <span className="muted">—</span>}</td>
                        <td><StatusChip tone={form.enabled ? "success" : "default"} label={form.enabled ? "Active" : "Disabled"} /></td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <button className="btn ghost danger" style={{ fontSize: 12, padding: "3px 8px" }}
                            onClick={async () => {
                              setDeleteError("");
                              if (!confirm(`Delete queue "${form.name}"?`)) return;
                              try {
                                await deletePbxResource("queues", id);
                                setReloadKey((k) => k + 1);
                                if (editing?.id === id) setEditing(null);
                              } catch (e: any) {
                                setDeleteError(e?.message || "Delete failed.");
                              }
                            }}>Del</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
        {editing ? (
          <div style={{ flex: "0 0 44%", marginLeft: 16, overflowY: "auto", borderLeft: "1px solid var(--border)", paddingLeft: 16 }}>
            <QueueEditor
              initial={editing.form}
              queueId={editing.id}
              onSaved={() => { setReloadKey((k) => k + 1); setEditing(null); }}
              onCancel={() => setEditing(null)}
            />
          </div>
        ) : null}
      </div>
    </PermissionGate>
  );
}
