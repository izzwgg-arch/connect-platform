"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "../../../../components/PageHeader";
import { DetailCard } from "../../../../components/DetailCard";
import { EmptyState } from "../../../../components/EmptyState";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { ErrorState } from "../../../../components/ErrorState";
import { StatusChip } from "../../../../components/StatusChip";
import { useAsyncResource } from "../../../../hooks/useAsyncResource";
import { apiGet, apiPost, apiPatch, apiDelete } from "../../../../services/apiClient";

// ── Types ────────────────────────────────────────────────────────────────────

type DestinationType = "extension" | "queue" | "voicemail" | "external" | "ivr" | "operator" | "hangup";

interface DigitOption {
  digit: string; // "0"–"9", "*", "#"
  label: string;
  destType: DestinationType;
  destValue: string; // extension number, queue name, phone number, etc.
}

interface IvrRecord {
  id: string;
  name: string;
  description?: string;
  greeting?: string;
  timeout?: number;
  invalidDest?: string;
  timeoutDest?: string;
  options: DigitOption[];
}

interface Recording {
  id: string;
  name: string;
  filename?: string;
}

const DEST_LABELS: Record<DestinationType, string> = {
  extension: "Extension",
  queue: "Queue",
  voicemail: "Voicemail",
  external: "External Number",
  ivr: "IVR Menu",
  operator: "Operator (0)",
  hangup: "Hang Up",
};

const DIGIT_OPTIONS = ["1","2","3","4","5","6","7","8","9","0","*","#"];

const EMPTY_OPTION: DigitOption = { digit: "1", label: "", destType: "extension", destValue: "" };

function newIvr(): IvrRecord {
  return {
    id: "",
    name: "",
    description: "",
    greeting: "",
    timeout: 10,
    invalidDest: "",
    timeoutDest: "",
    options: [{ ...EMPTY_OPTION }],
  };
}

// ── Sub-components ───────────────────────────────────────────────────────────

function DestRow({
  opt,
  idx,
  recordings,
  onChange,
  onRemove,
  usedDigits,
}: {
  opt: DigitOption;
  idx: number;
  recordings: Recording[];
  onChange: (idx: number, field: keyof DigitOption, value: string) => void;
  onRemove: (idx: number) => void;
  usedDigits: Set<string>;
}) {
  return (
    <tr>
      <td style={{ width: 70 }}>
        <select
          className="select"
          value={opt.digit}
          onChange={(e) => onChange(idx, "digit", e.target.value)}
        >
          {DIGIT_OPTIONS.map((d) => (
            <option key={d} value={d} disabled={d !== opt.digit && usedDigits.has(d)}>
              Press {d}
            </option>
          ))}
        </select>
      </td>
      <td>
        <input
          className="input"
          placeholder="Label (e.g. Sales)"
          value={opt.label}
          onChange={(e) => onChange(idx, "label", e.target.value)}
        />
      </td>
      <td style={{ width: 160 }}>
        <select
          className="select"
          value={opt.destType}
          onChange={(e) => onChange(idx, "destType", e.target.value as DestinationType)}
        >
          {Object.entries(DEST_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </td>
      <td>
        {opt.destType !== "operator" && opt.destType !== "hangup" ? (
          <input
            className="input"
            placeholder={
              opt.destType === "extension" ? "e.g. 1001" :
              opt.destType === "queue" ? "Queue name / ID" :
              opt.destType === "external" ? "+15551234567" :
              opt.destType === "ivr" ? "IVR ID" :
              "Voicemail box"
            }
            value={opt.destValue}
            onChange={(e) => onChange(idx, "destValue", e.target.value)}
          />
        ) : (
          <span className="muted" style={{ fontSize: 12 }}>—</span>
        )}
      </td>
      <td style={{ width: 50, textAlign: "center" }}>
        <button className="btn ghost" style={{ padding: "4px 10px", fontSize: 13 }} onClick={() => onRemove(idx)}>
          ✕
        </button>
      </td>
    </tr>
  );
}

// ── Editor Panel ─────────────────────────────────────────────────────────────

function IvrEditor({
  ivr,
  recordings,
  onSave,
  onCancel,
  saving,
  saveError,
}: {
  ivr: IvrRecord;
  recordings: Recording[];
  onSave: (ivr: IvrRecord) => void;
  onCancel: () => void;
  saving: boolean;
  saveError: string;
}) {
  const [form, setForm] = useState<IvrRecord>({ ...ivr, options: ivr.options.map((o) => ({ ...o })) });

  function setField<K extends keyof IvrRecord>(key: K, val: IvrRecord[K]) {
    setForm((f) => ({ ...f, [key]: val }));
  }

  function changeOption(idx: number, field: keyof DigitOption, value: string) {
    setForm((f) => {
      const opts = f.options.map((o, i) => i === idx ? { ...o, [field]: value } : o);
      return { ...f, options: opts };
    });
  }

  function addOption() {
    setForm((f) => {
      const used = new Set(f.options.map((o) => o.digit));
      const next = DIGIT_OPTIONS.find((d) => !used.has(d)) || "0";
      return { ...f, options: [...f.options, { digit: next, label: "", destType: "extension", destValue: "" }] };
    });
  }

  function removeOption(idx: number) {
    setForm((f) => ({ ...f, options: f.options.filter((_, i) => i !== idx) }));
  }

  const usedDigits = useMemo(() => new Set(form.options.map((o) => o.digit)), [form.options]);

  return (
    <div className="panel stack" style={{ gap: 18 }}>
      <h3 style={{ fontSize: 16, fontWeight: 650, marginBottom: 4 }}>
        {form.id ? `Edit IVR: ${form.name}` : "Create New IVR"}
      </h3>

      {/* Basic Info */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <label className="label">IVR Name *</label>
          <input
            className="input"
            placeholder="e.g. Main Menu"
            value={form.name}
            onChange={(e) => setField("name", e.target.value)}
          />
        </div>
        <div>
          <label className="label">Description</label>
          <input
            className="input"
            placeholder="Optional description"
            value={form.description || ""}
            onChange={(e) => setField("description", e.target.value)}
          />
        </div>
        <div>
          <label className="label">Greeting Recording</label>
          <select
            className="select"
            value={form.greeting || ""}
            onChange={(e) => setField("greeting", e.target.value)}
          >
            <option value="">— No greeting / use system default —</option>
            {recordings.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Digit Timeout (seconds)</label>
          <input
            className="input"
            type="number"
            min={3}
            max={60}
            value={form.timeout ?? 10}
            onChange={(e) => setField("timeout", Number(e.target.value))}
          />
        </div>
        <div>
          <label className="label">On Invalid Press → Destination</label>
          <input
            className="input"
            placeholder="e.g. extension 1000"
            value={form.invalidDest || ""}
            onChange={(e) => setField("invalidDest", e.target.value)}
          />
        </div>
        <div>
          <label className="label">On Timeout → Destination</label>
          <input
            className="input"
            placeholder="e.g. voicemail 1000"
            value={form.timeoutDest || ""}
            onChange={(e) => setField("timeoutDest", e.target.value)}
          />
        </div>
      </div>

      {/* Menu Options */}
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <h4 style={{ fontSize: 14, fontWeight: 600 }}>Menu Options</h4>
          <button
            className="btn ghost"
            style={{ fontSize: 13 }}
            onClick={addOption}
            disabled={form.options.length >= DIGIT_OPTIONS.length}
          >
            + Add Option
          </button>
        </div>
        {form.options.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>No options defined — callers will hear the greeting then timeout.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  <th style={{ textAlign: "left", padding: "4px 8px", color: "var(--text-dim)" }}>Digit</th>
                  <th style={{ textAlign: "left", padding: "4px 8px", color: "var(--text-dim)" }}>Label</th>
                  <th style={{ textAlign: "left", padding: "4px 8px", color: "var(--text-dim)" }}>Destination Type</th>
                  <th style={{ textAlign: "left", padding: "4px 8px", color: "var(--text-dim)" }}>Value</th>
                  <th style={{ width: 50 }} />
                </tr>
              </thead>
              <tbody>
                {form.options.map((opt, idx) => (
                  <DestRow
                    key={idx}
                    opt={opt}
                    idx={idx}
                    recordings={recordings}
                    onChange={changeOption}
                    onRemove={removeOption}
                    usedDigits={usedDigits}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Actions */}
      {saveError ? <div className="chip danger">{saveError}</div> : null}
      <div className="row-actions">
        <button className="btn" onClick={() => onSave(form)} disabled={saving || !form.name.trim()}>
          {saving ? "Saving…" : (form.id ? "Save Changes" : "Create IVR")}
        </button>
        <button className="btn ghost" onClick={onCancel} disabled={saving}>Cancel</button>
      </div>
    </div>
  );
}

// ── IVR Row Card ─────────────────────────────────────────────────────────────

function IvrCard({
  ivr,
  onEdit,
  onDelete,
  deleting,
}: {
  ivr: IvrRecord;
  onEdit: (ivr: IvrRecord) => void;
  onDelete: (id: string) => void;
  deleting: boolean;
}) {
  return (
    <div className="panel" style={{ padding: "14px 16px", display: "flex", alignItems: "flex-start", gap: 16 }}>
      <div style={{
        width: 44, height: 44, borderRadius: 10,
        background: "var(--accent)", color: "#fff",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 18, fontWeight: 700, flexShrink: 0
      }}>
        IV
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <span style={{ fontWeight: 650, fontSize: 15 }}>{ivr.name}</span>
          {ivr.description ? (
            <span className="muted" style={{ fontSize: 12 }}>— {ivr.description}</span>
          ) : null}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {ivr.options.length === 0 ? (
            <span className="chip" style={{ fontSize: 11 }}>No menu options</span>
          ) : (
            ivr.options.map((opt) => (
              <span key={opt.digit} className="chip" style={{ fontSize: 11 }}>
                {opt.digit} → {opt.label || DEST_LABELS[opt.destType]} ({opt.destType})
              </span>
            ))
          )}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
        <button className="btn ghost" style={{ fontSize: 13 }} onClick={() => onEdit(ivr)}>Edit</button>
        <button
          className="btn ghost danger"
          style={{ fontSize: 13 }}
          onClick={() => onDelete(ivr.id)}
          disabled={deleting}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function IvrBuilderPage() {
  const [reloadKey, setReloadKey] = useState(0);
  const [editing, setEditing] = useState<IvrRecord | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [opMessage, setOpMessage] = useState("");

  // Load IVRs from VitalPBX via the generic resource proxy
  const ivrState = useAsyncResource<{ rows: Record<string, unknown>[] }>(
    () => apiGet("/voice/pbx/resources/ivr"),
    [reloadKey]
  );

  // Load recordings/announcements for greeting picker
  const recordingsState = useAsyncResource<{ rows: Record<string, unknown>[] }>(
    () => apiGet("/voice/pbx/resources/voicemail"),
    []
  );

  const recordings: Recording[] = useMemo(() => {
    if (recordingsState.status !== "success") return [];
    return recordingsState.data.rows.map((r, i) => ({
      id: String(r.id ?? r.uuid ?? i),
      name: String(r.name ?? r.filename ?? `Recording ${i + 1}`),
    }));
  }, [recordingsState]);

  // Normalise IVR rows from VitalPBX format
  const ivrs: IvrRecord[] = useMemo(() => {
    if (ivrState.status !== "success") return [];
    return ivrState.data.rows.map((r) => ({
      id: String(r.id ?? r.uuid ?? r.ivr_id ?? ""),
      name: String(r.name ?? r.ivr_name ?? "Unnamed IVR"),
      description: String(r.description ?? r.ivr_description ?? ""),
      greeting: String(r.greeting ?? r.announcement ?? ""),
      timeout: Number(r.timeout ?? r.digit_timeout ?? 10),
      invalidDest: String(r.invalid_destination ?? ""),
      timeoutDest: String(r.timeout_destination ?? ""),
      options: (() => {
        // VitalPBX may store options as JSON or as separate columns
        if (Array.isArray(r.options)) {
          return (r.options as any[]).map((o: any) => ({
            digit: String(o.digit ?? "0"),
            label: String(o.label ?? ""),
            destType: (o.destType ?? o.dest_type ?? "extension") as DestinationType,
            destValue: String(o.destValue ?? o.dest_value ?? ""),
          }));
        }
        return [];
      })(),
    }));
  }, [ivrState]);

  async function handleSave(form: IvrRecord) {
    setSaving(true);
    setSaveError("");
    try {
      const payload = {
        name: form.name,
        description: form.description,
        greeting: form.greeting,
        timeout: form.timeout,
        invalid_destination: form.invalidDest,
        timeout_destination: form.timeoutDest,
        options: form.options,
      };
      if (form.id) {
        await apiPatch(`/voice/pbx/resources/ivr/${form.id}`, { payload });
        setOpMessage(`IVR "${form.name}" updated.`);
      } else {
        await apiPost("/voice/pbx/resources/ivr", { payload });
        setOpMessage(`IVR "${form.name}" created.`);
      }
      setEditing(null);
      setReloadKey((k) => k + 1);
    } catch (err: any) {
      setSaveError(err?.message || "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    setDeleteId(id);
    try {
      await apiDelete(`/voice/pbx/resources/ivr/${id}`);
      setOpMessage("IVR deleted.");
      setReloadKey((k) => k + 1);
    } catch (err: any) {
      setOpMessage(`Delete failed: ${err?.message || "unknown error"}`);
    } finally {
      setDeleteId(null);
    }
  }

  return (
    <div className="stack compact-stack">
      <PageHeader
        title="IVR Builder"
        subtitle="Create and manage interactive voice response menus, greetings, and call flow destinations."
        actions={
          !editing ? (
            <button className="btn" onClick={() => { setEditing(newIvr()); setSaveError(""); }}>
              + New IVR
            </button>
          ) : null
        }
      />

      {opMessage ? (
        <div className="chip success" style={{ alignSelf: "flex-start" }}>{opMessage}</div>
      ) : null}

      {/* Editor */}
      {editing ? (
        <IvrEditor
          ivr={editing}
          recordings={recordings}
          onSave={handleSave}
          onCancel={() => { setEditing(null); setSaveError(""); }}
          saving={saving}
          saveError={saveError}
        />
      ) : null}

      {/* IVR List */}
      {!editing && (
        <>
          {ivrState.status === "loading" ? <LoadingSkeleton rows={4} /> : null}

          {/* VitalPBX API v2 does not expose IVR endpoints — show a clear notice */}
          {ivrState.status === "error" && (
            ivrState.error?.includes("NOT_SUPPORTED") ||
            ivrState.error?.includes("IVR endpoints are not present") ||
            ivrState.error?.includes("resource_not_supported")
          ) ? (
            <div className="state-box" style={{ borderLeft: "4px solid var(--accent)", background: "var(--surface-2)" }}>
              <strong>VitalPBX API Limitation</strong>
              <p style={{ marginTop: 6, fontSize: 13, lineHeight: 1.6 }}>
                VitalPBX public API v2 does not expose IVR management endpoints. IVRs cannot be read from or written to the PBX via this interface.
              </p>
              <p style={{ marginTop: 6, fontSize: 13, lineHeight: 1.6 }}>
                To manage IVR menus on your PBX, use the{" "}
                <strong>VitalPBX Admin Panel</strong> directly (Admin → IVR → IVR Normal).
                You can still use the builder below to design menu structures locally.
              </p>
            </div>
          ) : ivrState.status === "error" && ivrState.error?.includes("PBX_LINK_NOT_FOUND") ? (
            <div className="state-box">
              <strong>PBX Not Linked</strong>
              <p style={{ marginTop: 6, fontSize: 13 }}>
                This tenant has no PBX instance configured. Link a PBX in{" "}
                <a className="link" href="/admin/pbx">Admin → PBX Setup</a>.
              </p>
            </div>
          ) : ivrState.status === "error" ? (
            <ErrorState message={ivrState.error} />
          ) : null}

          {(ivrState.status === "success" || ivrState.status === "error") && ivrs.length === 0 ? (
            <EmptyState
              title="No IVR menus yet"
              message="Create your first IVR to start routing callers through an interactive menu."
            />
          ) : null}
          {ivrs.length > 0 ? (
            <div className="stack compact-stack">
              {ivrs.map((ivr) => (
                <IvrCard
                  key={ivr.id}
                  ivr={ivr}
                  onEdit={(r) => { setEditing(r); setSaveError(""); setOpMessage(""); }}
                  onDelete={handleDelete}
                  deleting={deleteId === ivr.id}
                />
              ))}
            </div>
          ) : null}
        </>
      )}

      {/* Info card */}
      {!editing && (
        <DetailCard title="About IVR Routing">
          <div style={{ fontSize: 13, color: "var(--text-dim)", lineHeight: 1.7 }}>
            <p>Each IVR menu plays a greeting then waits for a digit press. Configure each digit to route to an extension, queue, voicemail box, another IVR, or an external number.</p>
            <p style={{ marginTop: 8 }}>Use <strong>Temporary Overrides</strong> in <a href="/pbx/ivr/override" className="link">IVR Override Scheduler</a> to temporarily replace any IVR for a set time window — perfect for holidays and emergency announcements.</p>
          </div>
        </DetailCard>
      )}
    </div>
  );
}
