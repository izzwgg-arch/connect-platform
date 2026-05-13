"use client";

import { useEffect, useState, useRef } from "react";
import { Plus, Pencil, Archive, FileText, Check, X } from "lucide-react";
import { PageHeader } from "../../../../components/PageHeader";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { apiGet, apiPost, apiPatch } from "../../../../services/apiClient";

// ── Types ─────────────────────────────────────────────────────────────────────

type Script = {
  id: string;
  name: string;
  body: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

type ScriptSummary = Omit<Script, "body">;

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CrmScriptsPage() {
  const [scripts, setScripts] = useState<ScriptSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Selected script for viewing/editing
  const [selected, setSelected] = useState<Script | null>(null);
  const [loadingScript, setLoadingScript] = useState(false);

  // Edit mode
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editBody, setEditBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");

  // Create mode
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newBody, setNewBody] = useState("");
  const [createSaving, setCreateSaving] = useState(false);

  const bodyRef = useRef<HTMLTextAreaElement>(null);

  async function loadList() {
    try {
      const res = await apiGet<{ scripts: ScriptSummary[] }>("/crm/scripts?includeInactive=true");
      setScripts(res.scripts ?? []);
    } catch (err: unknown) {
      setError(String((err as Error)?.message ?? "Failed to load scripts"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadList(); }, []);

  async function loadScript(id: string) {
    setLoadingScript(true);
    try {
      const res = await apiGet<{ script: Script }>(`/crm/scripts/${id}`);
      setSelected(res.script);
      setEditing(false);
    } catch {
      setSelected(null);
    } finally {
      setLoadingScript(false);
    }
  }

  function startEdit() {
    if (!selected) return;
    setEditName(selected.name);
    setEditBody(selected.body);
    setEditing(true);
    setSavedMsg("");
    setTimeout(() => bodyRef.current?.focus(), 50);
  }

  async function saveEdit() {
    if (!selected) return;
    setSaving(true);
    try {
      const res = await apiPatch<{ script: Script }>(`/crm/scripts/${selected.id}`, { name: editName, body: editBody });
      setSelected(res.script);
      setEditing(false);
      setSavedMsg("Saved");
      setScripts((prev) => prev.map((s) => s.id === res.script.id ? { ...s, name: res.script.name, updatedAt: res.script.updatedAt } : s));
      setTimeout(() => setSavedMsg(""), 2000);
    } catch {
      setSavedMsg("Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function archiveScript(id: string) {
    await apiPatch(`/crm/scripts/${id}`, { isActive: false });
    setScripts((prev) => prev.map((s) => s.id === id ? { ...s, isActive: false } : s));
    if (selected?.id === id) setSelected((s) => s ? { ...s, isActive: false } : null);
  }

  async function restoreScript(id: string) {
    await apiPatch(`/crm/scripts/${id}`, { isActive: true });
    setScripts((prev) => prev.map((s) => s.id === id ? { ...s, isActive: true } : s));
    if (selected?.id === id) setSelected((s) => s ? { ...s, isActive: true } : null);
  }

  async function createScript() {
    if (!newName.trim() || !newBody.trim()) return;
    setCreateSaving(true);
    try {
      const res = await apiPost<{ script: Script }>("/crm/scripts", { name: newName.trim(), body: newBody.trim() });
      setScripts((prev) => [res.script, ...prev]);
      setCreating(false);
      setNewName("");
      setNewBody("");
      setSelected(res.script);
    } finally {
      setCreateSaving(false);
    }
  }

  const activeScripts = scripts.filter((s) => s.isActive);
  const archivedScripts = scripts.filter((s) => !s.isActive);

  const inputStyle: React.CSSProperties = {
    width: "100%", boxSizing: "border-box",
    padding: "0.5rem 0.75rem", borderRadius: 6,
    border: "1px solid var(--border, #e5e7eb)",
    background: "var(--input-bg, #fff)",
    fontSize: "0.875rem", color: "var(--text, #111)",
  };

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto", padding: "1.5rem 1.25rem" }}>
      <PageHeader
        title="Call Scripts"
        subtitle="Scripts displayed to agents during calls."
        actions={
          <button
            onClick={() => { setCreating(true); setSelected(null); setEditing(false); }}
            style={{
              display: "flex", alignItems: "center", gap: "0.375rem",
              padding: "0.4375rem 1rem", borderRadius: 6,
              background: "var(--accent, #6366f1)", color: "#fff",
              border: "none", cursor: "pointer", fontWeight: 600, fontSize: "0.875rem",
            }}
          >
            <Plus size={15} /> New Script
          </button>
        }
      />

      {loading && <LoadingSkeleton />}
      {error && <div style={{ padding: "1rem", background: "#fee2e2", borderRadius: 8, color: "#991b1b", fontSize: "0.875rem" }}>{error}</div>}

      {!loading && (
        <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: "1.25rem", alignItems: "start" }}>
          {/* Left: list */}
          <div className="panel" style={{ padding: "0.75rem" }}>
            {activeScripts.length === 0 && !creating && (
              <p style={{ fontSize: "0.8125rem", color: "var(--text-dim, #9ca3af)", padding: "0.5rem" }}>
                No scripts yet. Create one to get started.
              </p>
            )}

            {activeScripts.map((s) => (
              <button
                key={s.id}
                onClick={() => loadScript(s.id)}
                style={{
                  display: "flex", alignItems: "center", gap: "0.5rem", width: "100%",
                  padding: "0.5rem 0.625rem", borderRadius: 6, textAlign: "left",
                  background: selected?.id === s.id ? "var(--accent-light, #ede9fe)" : "transparent",
                  border: "none", cursor: "pointer",
                  color: selected?.id === s.id ? "var(--accent, #6366f1)" : "var(--text, #111)",
                }}
              >
                <FileText size={13} style={{ flexShrink: 0 }} />
                <span style={{ fontSize: "0.8125rem", fontWeight: selected?.id === s.id ? 600 : 400, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {s.name}
                </span>
              </button>
            ))}

            {archivedScripts.length > 0 && (
              <>
                <div style={{ fontSize: "0.6875rem", fontWeight: 700, color: "var(--text-dim, #9ca3af)", padding: "0.75rem 0.625rem 0.25rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  Archived
                </div>
                {archivedScripts.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => loadScript(s.id)}
                    style={{
                      display: "flex", alignItems: "center", gap: "0.5rem", width: "100%",
                      padding: "0.5rem 0.625rem", borderRadius: 6, textAlign: "left",
                      background: selected?.id === s.id ? "#f3f4f6" : "transparent",
                      border: "none", cursor: "pointer",
                      opacity: 0.6,
                    }}
                  >
                    <FileText size={13} style={{ flexShrink: 0, color: "#9ca3af" }} />
                    <span style={{ fontSize: "0.8125rem", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#9ca3af" }}>
                      {s.name}
                    </span>
                  </button>
                ))}
              </>
            )}
          </div>

          {/* Right: detail / edit / create */}
          <div className="panel" style={{ padding: "1.25rem" }}>
            {/* Create form */}
            {creating && (
              <>
                <h3 style={{ margin: "0 0 1rem", fontSize: "1rem", fontWeight: 600 }}>New Script</h3>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                  <input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="Script name"
                    style={inputStyle}
                    autoFocus
                  />
                  <textarea
                    value={newBody}
                    onChange={(e) => setNewBody(e.target.value)}
                    placeholder="Script content…"
                    rows={14}
                    style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }}
                  />
                  <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
                    <button onClick={() => { setCreating(false); setNewName(""); setNewBody(""); }}
                      style={{ padding: "0.4375rem 0.875rem", borderRadius: 6, background: "transparent", border: "1px solid var(--border, #e5e7eb)", cursor: "pointer", fontSize: "0.8125rem" }}>
                      Cancel
                    </button>
                    <button
                      onClick={createScript}
                      disabled={!newName.trim() || !newBody.trim() || createSaving}
                      style={{ padding: "0.4375rem 1rem", borderRadius: 6, background: "var(--accent, #6366f1)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600, fontSize: "0.8125rem", opacity: (!newName.trim() || !newBody.trim() || createSaving) ? 0.5 : 1 }}>
                      {createSaving ? "Creating…" : "Create Script"}
                    </button>
                  </div>
                </div>
              </>
            )}

            {/* Loading indicator */}
            {!creating && loadingScript && <LoadingSkeleton />}

            {/* No selection */}
            {!creating && !loadingScript && !selected && (
              <div style={{ textAlign: "center", padding: "2rem", color: "var(--text-dim, #9ca3af)" }}>
                <FileText size={32} style={{ margin: "0 auto 0.75rem" }} />
                <p style={{ fontSize: "0.875rem" }}>Select a script to view or edit.</p>
              </div>
            )}

            {/* Script detail/edit */}
            {!creating && !loadingScript && selected && (
              <>
                <div style={{ display: "flex", alignItems: "flex-start", gap: "0.5rem", marginBottom: "1rem" }}>
                  {editing ? (
                    <input value={editName} onChange={(e) => setEditName(e.target.value)}
                      style={{ ...inputStyle, flex: 1, fontWeight: 600, fontSize: "1rem" }} autoFocus />
                  ) : (
                    <h3 style={{ margin: 0, fontSize: "1rem", fontWeight: 600, flex: 1 }}>
                      {selected.name}
                      {!selected.isActive && <span style={{ marginLeft: "0.5rem", fontSize: "0.6875rem", background: "#f3f4f6", color: "#9ca3af", borderRadius: 4, padding: "0.125rem 0.375rem" }}>Archived</span>}
                    </h3>
                  )}
                  <div style={{ display: "flex", gap: "0.375rem", flexShrink: 0 }}>
                    {!editing && (
                      <>
                        <button onClick={startEdit} title="Edit" style={{ background: "none", border: "1px solid var(--border, #e5e7eb)", borderRadius: 6, padding: "0.3rem 0.625rem", cursor: "pointer", display: "flex", alignItems: "center", gap: "0.25rem", fontSize: "0.75rem" }}>
                          <Pencil size={12} /> Edit
                        </button>
                        {selected.isActive ? (
                          <button onClick={() => archiveScript(selected.id)} title="Archive" style={{ background: "none", border: "1px solid var(--border, #e5e7eb)", borderRadius: 6, padding: "0.3rem 0.625rem", cursor: "pointer", display: "flex", alignItems: "center", gap: "0.25rem", fontSize: "0.75rem", color: "#9ca3af" }}>
                            <Archive size={12} /> Archive
                          </button>
                        ) : (
                          <button onClick={() => restoreScript(selected.id)} title="Restore" style={{ background: "none", border: "1px solid var(--border, #e5e7eb)", borderRadius: 6, padding: "0.3rem 0.625rem", cursor: "pointer", display: "flex", alignItems: "center", gap: "0.25rem", fontSize: "0.75rem", color: "#10b981" }}>
                            Restore
                          </button>
                        )}
                      </>
                    )}
                    {editing && (
                      <>
                        <button onClick={saveEdit} disabled={saving}
                          style={{ background: "var(--accent, #6366f1)", color: "#fff", border: "none", borderRadius: 6, padding: "0.3rem 0.75rem", cursor: "pointer", display: "flex", alignItems: "center", gap: "0.25rem", fontSize: "0.75rem", fontWeight: 600 }}>
                          <Check size={12} /> {saving ? "Saving…" : "Save"}
                        </button>
                        <button onClick={() => setEditing(false)}
                          style={{ background: "none", border: "1px solid var(--border, #e5e7eb)", borderRadius: 6, padding: "0.3rem 0.625rem", cursor: "pointer", display: "flex", alignItems: "center", gap: "0.25rem", fontSize: "0.75rem" }}>
                          <X size={12} /> Cancel
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {savedMsg && <div style={{ marginBottom: "0.5rem", fontSize: "0.75rem", color: "#10b981" }}>{savedMsg}</div>}

                {editing ? (
                  <textarea ref={bodyRef} value={editBody} onChange={(e) => setEditBody(e.target.value)}
                    rows={16} style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }} />
                ) : (
                  <pre style={{ margin: 0, fontSize: "0.875rem", lineHeight: 1.65, whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--text, #111)", fontFamily: "inherit", background: "var(--surface-hover, #f9fafb)", padding: "1rem", borderRadius: 6, border: "1px solid var(--border, #e5e7eb)" }}>
                    {selected.body}
                  </pre>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
