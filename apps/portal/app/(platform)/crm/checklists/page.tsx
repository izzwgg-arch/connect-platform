"use client";

import { useEffect, useState } from "react";
import { Plus, Pencil, Archive, ClipboardList, Check, X, Trash2, GripVertical } from "lucide-react";
import { PageHeader } from "../../../../components/PageHeader";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { apiGet, apiPost, apiPatch } from "../../../../services/apiClient";

// ── Types ─────────────────────────────────────────────────────────────────────

type ChecklistItem = {
  id: string;
  label: string;
  required: boolean;
  sortOrder: number;
};

type Checklist = {
  id: string;
  name: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  items: ChecklistItem[];
};

// ── Item editor row ───────────────────────────────────────────────────────────

function ItemRow({
  item,
  onChange,
  onRemove,
  index,
}: {
  item: { label: string; required: boolean; sortOrder: number };
  onChange: (updated: typeof item) => void;
  onRemove: () => void;
  index: number;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.375rem 0" }}>
      <GripVertical size={14} style={{ color: "#9ca3af", flexShrink: 0, cursor: "grab" }} />
      <input
        value={item.label}
        onChange={(e) => onChange({ ...item, label: e.target.value })}
        placeholder={`Item ${index + 1}`}
        style={{
          flex: 1, padding: "0.375rem 0.625rem", borderRadius: 6,
          border: "1px solid var(--border, #e5e7eb)", fontSize: "0.8125rem",
          background: "var(--input-bg, #fff)", color: "var(--text, #111)",
        }}
      />
      <label style={{ display: "flex", alignItems: "center", gap: "0.25rem", fontSize: "0.75rem", color: "var(--text-dim, #6b7280)", flexShrink: 0, cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={item.required}
          onChange={(e) => onChange({ ...item, required: e.target.checked })}
          style={{ cursor: "pointer" }}
        />
        Required
      </label>
      <button
        onClick={onRemove}
        title="Remove"
        style={{ background: "none", border: "none", cursor: "pointer", padding: "0.25rem", color: "#ef4444", lineHeight: 1 }}
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CrmChecklistsPage() {
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Checklist | null>(null);

  // Edit state
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editItems, setEditItems] = useState<Array<{ label: string; required: boolean; sortOrder: number }>>([]);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");

  // Create state
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newItems, setNewItems] = useState<Array<{ label: string; required: boolean; sortOrder: number }>>([
    { label: "", required: false, sortOrder: 0 },
  ]);
  const [createSaving, setCreateSaving] = useState(false);

  async function loadList() {
    try {
      const res = await apiGet<{ checklists: Checklist[] }>("/crm/checklists?includeInactive=true");
      setChecklists(res.checklists ?? []);
    } catch (err: unknown) {
      setError(String((err as Error)?.message ?? "Failed to load checklists"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadList(); }, []);

  function startEdit() {
    if (!selected) return;
    setEditName(selected.name);
    setEditItems(selected.items.map((i) => ({ label: i.label, required: i.required, sortOrder: i.sortOrder })));
    setEditing(true);
    setSavedMsg("");
  }

  async function saveEdit() {
    if (!selected) return;
    setSaving(true);
    try {
      const res = await apiPatch<{ checklist: Checklist }>(`/crm/checklists/${selected.id}`, {
        name: editName,
        items: editItems.filter((i) => i.label.trim()).map((i, idx) => ({ ...i, sortOrder: idx })),
      });
      setSelected(res.checklist);
      setChecklists((prev) => prev.map((c) => c.id === res.checklist.id ? res.checklist : c));
      setEditing(false);
      setSavedMsg("Saved");
      setTimeout(() => setSavedMsg(""), 2000);
    } catch {
      setSavedMsg("Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function archiveChecklist(id: string) {
    await apiPatch(`/crm/checklists/${id}`, { isActive: false });
    setChecklists((prev) => prev.map((c) => c.id === id ? { ...c, isActive: false } : c));
    if (selected?.id === id) setSelected((s) => s ? { ...s, isActive: false } : null);
  }

  async function restoreChecklist(id: string) {
    await apiPatch(`/crm/checklists/${id}`, { isActive: true });
    setChecklists((prev) => prev.map((c) => c.id === id ? { ...c, isActive: true } : c));
    if (selected?.id === id) setSelected((s) => s ? { ...s, isActive: true } : null);
  }

  async function createChecklist() {
    const validItems = newItems.filter((i) => i.label.trim());
    if (!newName.trim()) return;
    setCreateSaving(true);
    try {
      const res = await apiPost<{ checklist: Checklist }>("/crm/checklists", {
        name: newName.trim(),
        items: validItems.map((i, idx) => ({ ...i, sortOrder: idx })),
      });
      setChecklists((prev) => [res.checklist, ...prev]);
      setCreating(false);
      setNewName("");
      setNewItems([{ label: "", required: false, sortOrder: 0 }]);
      setSelected(res.checklist);
    } finally {
      setCreateSaving(false);
    }
  }

  const activeChecklists = checklists.filter((c) => c.isActive);
  const archivedChecklists = checklists.filter((c) => !c.isActive);

  const inputStyle: React.CSSProperties = {
    width: "100%", boxSizing: "border-box",
    padding: "0.5rem 0.75rem", borderRadius: 6,
    border: "1px solid var(--border, #e5e7eb)",
    background: "var(--input-bg, #fff)",
    fontSize: "0.875rem", color: "var(--text, #111)",
  };

  // Current items being edited (create or edit mode)
  const workingItems = creating ? newItems : editItems;
  const setWorkingItems = creating ? setNewItems : setEditItems;

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto", padding: "1.5rem 1.25rem" }}>
      <PageHeader
        title="Checklists"
        subtitle="Structured call checklists for agents."
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
            <Plus size={15} /> New Checklist
          </button>
        }
      />

      {loading && <LoadingSkeleton />}
      {error && <div style={{ padding: "1rem", background: "#fee2e2", borderRadius: 8, color: "#991b1b", fontSize: "0.875rem" }}>{error}</div>}

      {!loading && (
        <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: "1.25rem", alignItems: "start" }}>
          {/* Left list */}
          <div className="panel" style={{ padding: "0.75rem" }}>
            {activeChecklists.length === 0 && !creating && (
              <p style={{ fontSize: "0.8125rem", color: "var(--text-dim, #9ca3af)", padding: "0.5rem" }}>
                No checklists yet.
              </p>
            )}
            {activeChecklists.map((c) => (
              <button
                key={c.id}
                onClick={() => { setSelected(c); setEditing(false); setCreating(false); }}
                style={{
                  display: "flex", alignItems: "center", gap: "0.5rem", width: "100%",
                  padding: "0.5rem 0.625rem", borderRadius: 6, textAlign: "left",
                  background: selected?.id === c.id ? "var(--accent-light, #ede9fe)" : "transparent",
                  border: "none", cursor: "pointer",
                  color: selected?.id === c.id ? "var(--accent, #6366f1)" : "var(--text, #111)",
                }}
              >
                <ClipboardList size={13} style={{ flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: "0.8125rem", fontWeight: selected?.id === c.id ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {c.name}
                  </div>
                  <div style={{ fontSize: "0.6875rem", color: "var(--text-dim, #9ca3af)" }}>{c.items.length} items</div>
                </div>
              </button>
            ))}
            {archivedChecklists.length > 0 && (
              <>
                <div style={{ fontSize: "0.6875rem", fontWeight: 700, color: "var(--text-dim, #9ca3af)", padding: "0.75rem 0.625rem 0.25rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Archived</div>
                {archivedChecklists.map((c) => (
                  <button key={c.id} onClick={() => { setSelected(c); setEditing(false); setCreating(false); }}
                    style={{ display: "flex", alignItems: "center", gap: "0.5rem", width: "100%", padding: "0.5rem 0.625rem", borderRadius: 6, textAlign: "left", background: selected?.id === c.id ? "#f3f4f6" : "transparent", border: "none", cursor: "pointer", opacity: 0.6 }}>
                    <ClipboardList size={13} style={{ flexShrink: 0, color: "#9ca3af" }} />
                    <span style={{ fontSize: "0.8125rem", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#9ca3af" }}>{c.name}</span>
                  </button>
                ))}
              </>
            )}
          </div>

          {/* Right detail/edit/create */}
          <div className="panel" style={{ padding: "1.25rem" }}>
            {/* Create/edit item editor */}
            {(creating || editing) && (
              <>
                <h3 style={{ margin: "0 0 1rem", fontSize: "1rem", fontWeight: 600 }}>{creating ? "New Checklist" : "Edit Checklist"}</h3>
                <input
                  value={creating ? newName : editName}
                  onChange={(e) => creating ? setNewName(e.target.value) : setEditName(e.target.value)}
                  placeholder="Checklist name"
                  style={{ ...inputStyle, marginBottom: "1rem" }}
                  autoFocus
                />

                <div style={{ fontWeight: 600, fontSize: "0.875rem", marginBottom: "0.5rem" }}>Items</div>
                {workingItems.map((item, idx) => (
                  <ItemRow
                    key={idx}
                    item={item}
                    index={idx}
                    onChange={(updated) => {
                      const next = [...workingItems];
                      next[idx] = updated;
                      setWorkingItems(next);
                    }}
                    onRemove={() => setWorkingItems(workingItems.filter((_, i) => i !== idx))}
                  />
                ))}

                <button
                  onClick={() => setWorkingItems([...workingItems, { label: "", required: false, sortOrder: workingItems.length }])}
                  style={{
                    marginTop: "0.5rem", display: "flex", alignItems: "center", gap: "0.375rem",
                    padding: "0.375rem 0.75rem", borderRadius: 6, background: "transparent",
                    border: "1px dashed var(--border, #e5e7eb)", cursor: "pointer",
                    fontSize: "0.8125rem", color: "var(--text-dim, #6b7280)",
                  }}
                >
                  <Plus size={12} /> Add Item
                </button>

                <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end", marginTop: "1.25rem" }}>
                  <button
                    onClick={() => { creating ? setCreating(false) : setEditing(false); }}
                    style={{ padding: "0.4375rem 0.875rem", borderRadius: 6, background: "transparent", border: "1px solid var(--border, #e5e7eb)", cursor: "pointer", fontSize: "0.8125rem" }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={creating ? createChecklist : saveEdit}
                    disabled={(creating ? !newName.trim() : !editName.trim()) || saving || createSaving}
                    style={{
                      padding: "0.4375rem 1rem", borderRadius: 6,
                      background: "var(--accent, #6366f1)", color: "#fff",
                      border: "none", cursor: "pointer", fontWeight: 600, fontSize: "0.8125rem",
                      opacity: ((creating ? !newName.trim() : !editName.trim()) || saving || createSaving) ? 0.5 : 1,
                    }}
                  >
                    {(saving || createSaving) ? "Saving…" : creating ? "Create Checklist" : "Save Changes"}
                  </button>
                </div>
              </>
            )}

            {/* No selection */}
            {!creating && !editing && !selected && (
              <div style={{ textAlign: "center", padding: "2rem", color: "var(--text-dim, #9ca3af)" }}>
                <ClipboardList size={32} style={{ margin: "0 auto 0.75rem" }} />
                <p style={{ fontSize: "0.875rem" }}>Select a checklist to view or edit.</p>
              </div>
            )}

            {/* Read-only view */}
            {!creating && !editing && selected && (
              <>
                <div style={{ display: "flex", alignItems: "flex-start", gap: "0.5rem", marginBottom: "1rem" }}>
                  <h3 style={{ margin: 0, fontSize: "1rem", fontWeight: 600, flex: 1 }}>
                    {selected.name}
                    {!selected.isActive && <span style={{ marginLeft: "0.5rem", fontSize: "0.6875rem", background: "#f3f4f6", color: "#9ca3af", borderRadius: 4, padding: "0.125rem 0.375rem" }}>Archived</span>}
                  </h3>
                  <div style={{ display: "flex", gap: "0.375rem", flexShrink: 0 }}>
                    {savedMsg && <span style={{ fontSize: "0.75rem", color: "#10b981", padding: "0.3rem 0" }}>{savedMsg}</span>}
                    <button onClick={startEdit} style={{ background: "none", border: "1px solid var(--border, #e5e7eb)", borderRadius: 6, padding: "0.3rem 0.625rem", cursor: "pointer", display: "flex", alignItems: "center", gap: "0.25rem", fontSize: "0.75rem" }}>
                      <Pencil size={12} /> Edit
                    </button>
                    {selected.isActive ? (
                      <button onClick={() => archiveChecklist(selected.id)} style={{ background: "none", border: "1px solid var(--border, #e5e7eb)", borderRadius: 6, padding: "0.3rem 0.625rem", cursor: "pointer", display: "flex", alignItems: "center", gap: "0.25rem", fontSize: "0.75rem", color: "#9ca3af" }}>
                        <Archive size={12} /> Archive
                      </button>
                    ) : (
                      <button onClick={() => restoreChecklist(selected.id)} style={{ background: "none", border: "1px solid var(--border, #e5e7eb)", borderRadius: 6, padding: "0.3rem 0.625rem", cursor: "pointer", display: "flex", alignItems: "center", gap: "0.25rem", fontSize: "0.75rem", color: "#10b981" }}>
                        Restore
                      </button>
                    )}
                  </div>
                </div>

                {selected.items.length === 0 && (
                  <p style={{ fontSize: "0.875rem", color: "var(--text-dim, #9ca3af)" }}>No items. Click Edit to add items.</p>
                )}

                <div style={{ display: "flex", flexDirection: "column", gap: "0.375rem" }}>
                  {selected.items.map((item, i) => (
                    <div key={item.id} style={{ display: "flex", alignItems: "center", gap: "0.625rem", padding: "0.4375rem 0.625rem", borderRadius: 6, background: "var(--surface-hover, #f9fafb)", border: "1px solid var(--border, #e5e7eb)" }}>
                      <Check size={13} style={{ color: "var(--text-dim, #9ca3af)", flexShrink: 0 }} />
                      <span style={{ fontSize: "0.8125rem", flex: 1 }}>{item.label}</span>
                      {item.required && (
                        <span style={{ fontSize: "0.6875rem", fontWeight: 700, background: "#fef3c7", color: "#92400e", borderRadius: 4, padding: "0.125rem 0.375rem" }}>Required</span>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
