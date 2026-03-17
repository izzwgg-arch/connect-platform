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

// ── Tab definitions ───────────────────────────────────────────────────────────

type TabKey = "general" | "voicemail" | "recording" | "advanced" | "followme" | "hotdesking";

const TABS: { key: TabKey; label: string }[] = [
  { key: "general",    label: "General" },
  { key: "voicemail",  label: "Voicemail" },
  { key: "recording",  label: "Recording" },
  { key: "advanced",   label: "Advanced" },
  { key: "followme",   label: "Follow Me" },
  { key: "hotdesking", label: "Hotdesking" },
];

// ── Field helpers ─────────────────────────────────────────────────────────────

function TextField({ label, name, value, onChange, disabled = false, type = "text" }: {
  label: string; name: string; value: string; onChange: (v: string) => void; disabled?: boolean; type?: string;
}) {
  return (
    <div className="form-field">
      <label className="label" htmlFor={name}>{label}</label>
      <input
        id={name}
        type={type}
        className="input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        autoComplete="off"
      />
    </div>
  );
}

function SelectField({ label, name, value, onChange, options }: {
  label: string; name: string; value: string; onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="form-field">
      <label className="label" htmlFor={name}>{label}</label>
      <select id={name} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

function ToggleField({ label, name, value, onChange, description }: {
  label: string; name: string; value: boolean; onChange: (v: boolean) => void; description?: string;
}) {
  return (
    <div className="form-field" style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <button
        type="button"
        id={name}
        role="switch"
        aria-checked={value}
        className={`btn ghost${value ? " active" : ""}`}
        style={{ minWidth: 44, padding: "4px 12px", fontSize: 12 }}
        onClick={() => onChange(!value)}
      >
        {value ? "ON" : "OFF"}
      </button>
      <span>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{label}</div>
        {description ? <div className="muted" style={{ fontSize: 12 }}>{description}</div> : null}
      </span>
    </div>
  );
}

// ── Extension form state ──────────────────────────────────────────────────────

type ExtForm = {
  extension: string;
  displayName: string;
  email: string;
  secret: string;
  technology: string;
  context: string;
  status: string;
  // voicemail
  voicemailEnabled: boolean;
  voicemailPin: string;
  voicemailEmailNotify: boolean;
  voicemailDeleteAfterEmail: boolean;
  // recording
  recordInbound: boolean;
  recordOutbound: boolean;
  onDemandRecording: boolean;
  // advanced
  dtmfMode: string;
  nat: string;
  maxContacts: string;
  transport: string;
  // follow me
  followMeEnabled: boolean;
  followMeList: string;
  followMeRingTime: string;
  // hotdesking
  hotdeskEnabled: boolean;
  hotdeskPin: string;
};

function defaultForm(): ExtForm {
  return {
    extension: "", displayName: "", email: "", secret: "",
    technology: "pjsip", context: "from-internal", status: "enabled",
    voicemailEnabled: true, voicemailPin: "", voicemailEmailNotify: false, voicemailDeleteAfterEmail: false,
    recordInbound: false, recordOutbound: false, onDemandRecording: false,
    dtmfMode: "rfc4733", nat: "yes", maxContacts: "5", transport: "wss,udp,tcp,tls",
    followMeEnabled: false, followMeList: "", followMeRingTime: "20",
    hotdeskEnabled: false, hotdeskPin: "",
  };
}

function rowToForm(row: Record<string, unknown>): ExtForm {
  const s = (key: string, fallback = "") => String(row[key] ?? fallback);
  const b = (key: string, fallback = false) => {
    const v = row[key];
    if (v === undefined || v === null) return fallback;
    if (typeof v === "boolean") return v;
    return String(v).toLowerCase() === "yes" || String(v).toLowerCase() === "true" || String(v) === "1";
  };
  return {
    extension: s("extension") || s("name"),
    displayName: s("callerName") || s("displayName") || s("name"),
    email: s("email"),
    secret: s("secret") || s("password"),
    technology: s("technology") || "pjsip",
    context: s("context") || "from-internal",
    status: s("status") || "enabled",
    voicemailEnabled: b("voicemail") || b("voicemailEnabled"),
    voicemailPin: s("voicemailPin") || s("vmsecret"),
    voicemailEmailNotify: b("emailNotify") || b("voicemailEmailNotify"),
    voicemailDeleteAfterEmail: b("deleteAfterEmail") || b("voicemailDeleteAfterEmail"),
    recordInbound: b("recordInbound") || b("record_incoming"),
    recordOutbound: b("recordOutbound") || b("record_outgoing"),
    onDemandRecording: b("onDemandRecording"),
    dtmfMode: s("dtmfMode") || s("dtmf_mode") || "rfc4733",
    nat: s("nat") || "yes",
    maxContacts: s("maxContacts") || s("max_contacts") || "5",
    transport: s("transport") || "wss,udp,tcp,tls",
    followMeEnabled: b("followMeEnabled") || b("fmEnabled"),
    followMeList: s("followMeList") || s("fmList"),
    followMeRingTime: s("followMeRingTime") || s("fmRingTime") || "20",
    hotdeskEnabled: b("hotdeskEnabled") || b("hotdesking"),
    hotdeskPin: s("hotdeskPin") || s("hotdeskingPin"),
  };
}

function formToPayload(f: ExtForm): Record<string, unknown> {
  return {
    extension: f.extension,
    name: f.extension,
    callerName: f.displayName,
    displayName: f.displayName,
    email: f.email,
    secret: f.secret,
    technology: f.technology,
    context: f.context,
    status: f.status,
    voicemail: f.voicemailEnabled ? "yes" : "no",
    voicemailEnabled: f.voicemailEnabled,
    vmsecret: f.voicemailPin,
    emailNotify: f.voicemailEmailNotify,
    deleteAfterEmail: f.voicemailDeleteAfterEmail,
    recordInbound: f.recordInbound,
    recordOutbound: f.recordOutbound,
    onDemandRecording: f.onDemandRecording,
    dtmfMode: f.dtmfMode,
    nat: f.nat,
    maxContacts: Number(f.maxContacts) || 5,
    transport: f.transport,
    followMeEnabled: f.followMeEnabled,
    followMeList: f.followMeList,
    followMeRingTime: Number(f.followMeRingTime) || 20,
    hotdeskEnabled: f.hotdeskEnabled,
    hotdeskPin: f.hotdeskPin,
  };
}

// ── Extension editor panel ────────────────────────────────────────────────────

function ExtensionEditor({
  initial,
  extensionId,
  onSaved,
  onCancel,
}: {
  initial: ExtForm;
  extensionId: string | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [tab, setTab] = useState<TabKey>("general");
  const [form, setForm] = useState<ExtForm>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  function set(key: keyof ExtForm) {
    return (v: string | boolean) => setForm((f) => ({ ...f, [key]: v }));
  }

  async function handleSave() {
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const payload = formToPayload(form);
      if (extensionId) {
        await updatePbxResource("extensions", extensionId, payload);
      } else {
        await createPbxResource("extensions", payload);
      }
      setSuccess("Saved successfully.");
      onSaved();
    } catch (e: any) {
      setError(e?.message || "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="panel" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="panel-head" style={{ paddingBottom: 0 }}>
        <h3>{extensionId ? `Edit Extension ${form.extension}` : "Create Extension"}</h3>
        <div className="row-actions">
          <button className="btn ghost" onClick={onCancel} disabled={saving}>Cancel</button>
          <button className="btn" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs" style={{ borderBottom: "1px solid var(--border)", marginBottom: 16, paddingTop: 8 }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`tab${tab === t.key ? " active" : ""}`}
            onClick={() => setTab(t.key)}
            type="button"
          >
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: "auto", paddingRight: 4 }}>
        {tab === "general" && (
          <div className="form-grid">
            <TextField label="Extension Number" name="extension" value={form.extension} onChange={set("extension")} />
            <TextField label="Display Name" name="displayName" value={form.displayName} onChange={set("displayName")} />
            <TextField label="Email" name="email" value={form.email} onChange={set("email")} type="email" />
            <TextField label="SIP Secret / Password" name="secret" value={form.secret} onChange={set("secret")} type="password" />
            <SelectField
              label="Technology"
              name="technology"
              value={form.technology}
              onChange={set("technology")}
              options={[
                { value: "pjsip", label: "PJSIP (recommended)" },
                { value: "iax2", label: "IAX2" },
              ]}
            />
            <TextField label="Dial Plan Context" name="context" value={form.context} onChange={set("context")} />
            <SelectField
              label="Status"
              name="status"
              value={form.status}
              onChange={set("status")}
              options={[
                { value: "enabled", label: "Enabled" },
                { value: "disabled", label: "Disabled" },
              ]}
            />
          </div>
        )}

        {tab === "voicemail" && (
          <div className="form-grid">
            <ToggleField
              label="Voicemail Enabled"
              name="voicemailEnabled"
              value={form.voicemailEnabled}
              onChange={set("voicemailEnabled")}
              description="Activate voicemail for this extension"
            />
            <TextField label="Voicemail PIN" name="voicemailPin" value={form.voicemailPin} onChange={set("voicemailPin")} type="password" />
            <ToggleField
              label="Email Notifications"
              name="voicemailEmailNotify"
              value={form.voicemailEmailNotify}
              onChange={set("voicemailEmailNotify")}
              description="Send email on new voicemail"
            />
            <ToggleField
              label="Delete After Email"
              name="voicemailDeleteAfterEmail"
              value={form.voicemailDeleteAfterEmail}
              onChange={set("voicemailDeleteAfterEmail")}
              description="Remove voicemail after sending to email"
            />
          </div>
        )}

        {tab === "recording" && (
          <div className="form-grid">
            <ToggleField
              label="Record Inbound Calls"
              name="recordInbound"
              value={form.recordInbound}
              onChange={set("recordInbound")}
              description="Auto-record all inbound calls to this extension"
            />
            <ToggleField
              label="Record Outbound Calls"
              name="recordOutbound"
              value={form.recordOutbound}
              onChange={set("recordOutbound")}
              description="Auto-record all outbound calls from this extension"
            />
            <ToggleField
              label="On-Demand Recording"
              name="onDemandRecording"
              value={form.onDemandRecording}
              onChange={set("onDemandRecording")}
              description="Allow user to start/stop recording via feature code"
            />
          </div>
        )}

        {tab === "advanced" && (
          <div className="form-grid">
            <SelectField
              label="DTMF Mode"
              name="dtmfMode"
              value={form.dtmfMode}
              onChange={set("dtmfMode")}
              options={[
                { value: "rfc4733", label: "RFC 4733 (recommended)" },
                { value: "inband", label: "In-band audio" },
                { value: "info", label: "SIP INFO" },
                { value: "auto", label: "Auto-detect" },
              ]}
            />
            <SelectField
              label="NAT"
              name="nat"
              value={form.nat}
              onChange={set("nat")}
              options={[
                { value: "yes", label: "Yes — force NAT traversal" },
                { value: "no", label: "No — direct RTP" },
                { value: "comedia", label: "Comedia — symmetric RTP" },
                { value: "force_rport", label: "Force rport" },
              ]}
            />
            <TextField label="Max Simultaneous Contacts" name="maxContacts" value={form.maxContacts} onChange={set("maxContacts")} type="number" />
            <TextField
              label="Allowed Transports"
              name="transport"
              value={form.transport}
              onChange={set("transport")}
            />
          </div>
        )}

        {tab === "followme" && (
          <div className="form-grid">
            <ToggleField
              label="Follow Me Enabled"
              name="followMeEnabled"
              value={form.followMeEnabled}
              onChange={set("followMeEnabled")}
              description="Ring additional numbers when this extension is called"
            />
            <TextField
              label="Follow Me Numbers"
              name="followMeList"
              value={form.followMeList}
              onChange={set("followMeList")}
            />
            <p className="muted" style={{ fontSize: 12, gridColumn: "1 / -1" }}>
              Enter comma-separated numbers or extensions. Example: 102,+15551234567
            </p>
            <TextField label="Ring Time (seconds)" name="followMeRingTime" value={form.followMeRingTime} onChange={set("followMeRingTime")} type="number" />
          </div>
        )}

        {tab === "hotdesking" && (
          <div className="form-grid">
            <ToggleField
              label="Hotdesking Enabled"
              name="hotdeskEnabled"
              value={form.hotdeskEnabled}
              onChange={set("hotdeskEnabled")}
              description="Allow this extension to be used as a hotdesk station"
            />
            <TextField label="Hotdesk PIN" name="hotdeskPin" value={form.hotdeskPin} onChange={set("hotdeskPin")} type="password" />
          </div>
        )}
      </div>

      {success ? <div className="chip success" style={{ marginTop: 12 }}>{success}</div> : null}
      {error ? <div className="chip danger" style={{ marginTop: 12 }}>{error}</div> : null}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function PbxExtensionsPage() {
  const [reloadKey, setReloadKey] = useState(0);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<{ id: string | null; form: ExtForm } | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const state = useAsyncResource(() => loadPbxResource("extensions"), ["extensions", reloadKey]);
  const telephony = useTelephony();

  const activeExts = useMemo(() => {
    const s = new Set<string>();
    for (const call of telephony.activeCalls) {
      for (const ext of call.extensions ?? []) s.add(String(ext));
    }
    return s;
  }, [telephony.activeCalls]);

  const registeredExts = useMemo(() => {
    const s = new Set<string>();
    for (const ext of telephony.extensionList) {
      if (ext.status !== "unavailable" && ext.status !== "unknown") s.add(String(ext.extension));
    }
    return s;
  }, [telephony.extensionList]);

  const rows = useMemo(() => {
    if (state.status !== "success") return [];
    const q = query.trim().toLowerCase();
    return state.data.rows.filter((row) => {
      if (!q) return true;
      return Object.values(row).some((v) => String(v ?? "").toLowerCase().includes(q));
    });
  }, [state, query]);

  function presenceTone(ext: string): "success" | "danger" | "warning" | "default" {
    if (activeExts.has(ext)) return "danger";
    if (registeredExts.has(ext)) return "success";
    return "default";
  }

  function presenceLabel(ext: string): string {
    if (activeExts.has(ext)) return "On Call";
    if (registeredExts.has(ext)) return "Registered";
    return "Offline";
  }

  function getExtId(row: Record<string, unknown>, idx: number): string {
    return String(row.id ?? row.uuid ?? row.extension ?? row.name ?? idx);
  }

  return (
    <PermissionGate permission="can_view_team" fallback={<div className="state-box">You do not have access to extensions.</div>}>
      <div style={{ display: "flex", gap: 0, height: "100%", minHeight: 0 }}>
        {/* List panel */}
        <div style={{ flex: editing ? "0 0 55%" : "1 1 100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div className="stack compact-stack" style={{ padding: "0 0 12px 0" }}>
            <PageHeader
              title="Extensions"
              subtitle="Manage PBX extensions — click any row to edit, or create a new one."
            />
            <FilterBar>
              <SearchInput value={query} onChange={setQuery} placeholder="Search extensions..." />
              <button className="btn ghost" onClick={() => setReloadKey((k) => k + 1)}>Refresh</button>
              <button
                className="btn"
                onClick={() => setEditing({ id: null, form: defaultForm() })}
              >
                + New Extension
              </button>
            </FilterBar>
          </div>

          {deleteError ? <div className="chip danger" style={{ marginBottom: 8 }}>{deleteError}</div> : null}

          {state.status === "loading" ? <LoadingSkeleton rows={8} /> : null}
          {state.status === "error" ? (
            state.error?.includes("PBX_LINK_NOT_FOUND") ? (
              <div className="state-box">
                <strong>PBX Not Linked</strong>
                <p style={{ marginTop: 6, fontSize: 13 }}>
                  This tenant has no PBX instance configured. Link a PBX in{" "}
                  <a className="link" href="/admin/pbx">Admin → PBX Setup</a>.
                </p>
              </div>
            ) : state.error?.includes("CREDENTIALS_MASTER_KEY") ? (
              <div className="state-box">
                <strong>PBX Credentials Unavailable</strong>
                <p style={{ marginTop: 6, fontSize: 13 }}>
                  The server is missing the <code>CREDENTIALS_MASTER_KEY</code> environment variable needed to decrypt PBX credentials. Contact your system administrator.
                </p>
              </div>
            ) : (
              <ErrorState message={state.error} />
            )
          ) : null}
          {state.status === "success" && rows.length === 0 ? (
            <EmptyState title="No extensions found" message="No extensions returned from VitalPBX. Use the + New Extension button to create one." />
          ) : null}

          {state.status === "success" && rows.length > 0 ? (
            <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
              <table className="table" style={{ width: "100%" }}>
                <thead>
                  <tr>
                    <th>Extension</th>
                    <th>Name</th>
                    <th>Technology</th>
                    <th>Status</th>
                    <th>Presence</th>
                    <th style={{ width: 80 }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, idx) => {
                    const extNum = String(row.extension ?? row.name ?? "");
                    const id = getExtId(row, idx);
                    const isSelected = editing?.id === id;
                    return (
                      <tr
                        key={id}
                        onClick={() => setEditing({ id, form: rowToForm(row) })}
                        style={{ cursor: "pointer", background: isSelected ? "var(--surface-2)" : undefined }}
                      >
                        <td style={{ fontWeight: 600, fontFamily: "monospace" }}>{extNum}</td>
                        <td>{String(row.callerName ?? row.displayName ?? row.name ?? "—")}</td>
                        <td>{String(row.technology ?? "pjsip")}</td>
                        <td>
                          <StatusChip
                            tone={String(row.status ?? "enabled").toLowerCase() === "enabled" ? "success" : "default"}
                            label={String(row.status ?? "enabled")}
                          />
                        </td>
                        <td>
                          <StatusChip tone={presenceTone(extNum)} label={presenceLabel(extNum)} />
                        </td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <button
                            className="btn ghost danger"
                            style={{ fontSize: 12, padding: "3px 8px" }}
                            onClick={async () => {
                              setDeleteError("");
                              if (!confirm(`Delete extension ${extNum}?`)) return;
                              try {
                                await deletePbxResource("extensions", id);
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

        {/* Editor panel */}
        {editing ? (
          <div style={{ flex: "0 0 44%", marginLeft: 16, overflowY: "auto", borderLeft: "1px solid var(--border)", paddingLeft: 16 }}>
            <ExtensionEditor
              initial={editing.form}
              extensionId={editing.id}
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
