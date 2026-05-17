"use client";

import { useEffect, useState, useCallback } from "react";
import { ClipboardList } from "lucide-react";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { apiGet, apiPost, apiPatch } from "../../../../services/apiClient";
import { crm } from "../../../../components/crm/crmClasses";
import { CRMPageHeader } from "../../../../components/crm/CRMPageHeader";
import { ChecklistLibraryPanel } from "../../../../components/crm/checklists/ChecklistLibraryPanel";
import { ChecklistWorkspace } from "../../../../components/crm/checklists/ChecklistWorkspace";
import { ChecklistProgressPanel } from "../../../../components/crm/checklists/ChecklistProgressPanel";
import { CHECKLIST_TEMPLATES } from "../../../../components/crm/checklists/ChecklistTemplates";
import { cn } from "../../../../components/crm/cn";

// ── Types ──────────────────────────────────────────────────────────────────────

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

type EditItem = { label: string; required: boolean; sortOrder: number };

// ── Page ───────────────────────────────────────────────────────────────────────

export default function CrmChecklistsPage() {
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Checklist | null>(null);
  const [savedMsg, setSavedMsg] = useState("");

  // Create state
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createItems, setCreateItems] = useState<EditItem[]>([]);
  const [createSaving, setCreateSaving] = useState(false);

  async function loadList() {
    try {
      const res = await apiGet<{ checklists: Checklist[] }>(
        "/crm/checklists?includeInactive=true"
      );
      setChecklists(res.checklists ?? []);
    } catch (err: unknown) {
      setError(String((err as Error)?.message ?? "Failed to load checklists"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadList();
  }, []);

  // Select a checklist by id (may already be loaded with full items)
  function handleSelect(id: string) {
    const found = checklists.find((c) => c.id === id) ?? null;
    setSelected(found);
    setCreating(false);
  }

  // Start blank create
  function handleNewBlank() {
    setCreating(true);
    setSelected(null);
    setCreateName("");
    setCreateItems([{ label: "", required: false, sortOrder: 0 }]);
  }

  // Start from template
  function handleNewFromTemplate(templateId: string) {
    const tpl = CHECKLIST_TEMPLATES.find((t) => t.id === templateId);
    if (!tpl) return;
    setCreating(true);
    setSelected(null);
    setCreateName(tpl.name);
    setCreateItems(
      tpl.items.map((item, idx) => ({
        label: item.label,
        required: item.required,
        sortOrder: idx,
      }))
    );
  }

  const handleConfirmCreate = useCallback(async () => {
    if (!createName.trim()) return;
    setCreateSaving(true);
    try {
      const validItems = createItems
        .filter((i) => i.label.trim())
        .map((i, idx) => ({ ...i, sortOrder: idx }));
      const res = await apiPost<{ checklist: Checklist }>("/crm/checklists", {
        name: createName.trim(),
        items: validItems,
      });
      setChecklists((prev) => [res.checklist, ...prev]);
      setCreating(false);
      setSelected(res.checklist);
      setCreateName("");
      setCreateItems([]);
    } finally {
      setCreateSaving(false);
    }
  }, [createName, createItems]);

  const handleCancelCreate = useCallback(() => {
    setCreating(false);
    setCreateName("");
    setCreateItems([]);
  }, []);

  const handleSaveEdit = useCallback(
    async (name: string, items: EditItem[]) => {
      if (!selected) return;
      const res = await apiPatch<{ checklist: Checklist }>(
        `/crm/checklists/${selected.id}`,
        { name, items }
      );
      setSelected(res.checklist);
      setChecklists((prev) =>
        prev.map((c) => (c.id === res.checklist.id ? res.checklist : c))
      );
      setSavedMsg("Saved");
      setTimeout(() => setSavedMsg(""), 2500);
    },
    [selected]
  );

  const handleArchive = useCallback(
    async (id: string) => {
      await apiPatch(`/crm/checklists/${id}`, { isActive: false });
      setChecklists((prev) =>
        prev.map((c) => (c.id === id ? { ...c, isActive: false } : c))
      );
      if (selected?.id === id)
        setSelected((s) => (s ? { ...s, isActive: false } : null));
    },
    [selected]
  );

  const handleRestore = useCallback(
    async (id: string) => {
      await apiPatch(`/crm/checklists/${id}`, { isActive: true });
      setChecklists((prev) =>
        prev.map((c) => (c.id === id ? { ...c, isActive: true } : c))
      );
      if (selected?.id === id)
        setSelected((s) => (s ? { ...s, isActive: true } : null));
    },
    [selected]
  );

  // Sync selected checklist data when checklists list updates
  useEffect(() => {
    if (selected) {
      const updated = checklists.find((c) => c.id === selected.id);
      if (updated && updated !== selected) setSelected(updated);
    }
  }, [checklists, selected]);

  // ── Render ──

  if (loading) {
    return (
      <div className={cn(crm.checklistWorkspace, "crm-page-shell")}>
        <div className={crm.pageInnerChecklist}>
          <LoadingSkeleton />
        </div>
      </div>
    );
  }

  return (
    <div className={cn(crm.checklistWorkspace, "crm-page-shell")}>
      <div className={crm.pageInnerChecklist}>
        {/* Page header */}
        <CRMPageHeader
          icon={<ClipboardList size={18} />}
          title="Checklists"
          subtitle="Workflow checklists for agents — used during live calls and campaign outreach."
        />

        {error && (
          <div
            className={cn(
              crm.bannerDanger,
              "flex items-center gap-2 rounded-crm-lg px-4 py-3"
            )}
            role="alert"
          >
            <span className="text-sm">{error}</span>
          </div>
        )}

        {/* 3-column workspace */}
        <div className={crm.checklistGrid}>
          {/* Left: library */}
          <div className={crm.checklistLibraryCol}>
            <ChecklistLibraryPanel
              checklists={checklists}
              selectedId={selected?.id ?? null}
              onSelect={handleSelect}
              onNewBlank={handleNewBlank}
              onNewFromTemplate={handleNewFromTemplate}
              isCreating={creating}
            />
          </div>

          {/* Center: workspace */}
          <div className={crm.checklistWorkspaceCol}>
            <ChecklistWorkspace
              selected={selected}
              onSaveEdit={handleSaveEdit}
              onArchive={handleArchive}
              onRestore={handleRestore}
              savedMsg={savedMsg}
              creating={creating}
              createName={createName}
              createItems={createItems}
              onCreateNameChange={setCreateName}
              onCreateItemsChange={setCreateItems}
              onConfirmCreate={handleConfirmCreate}
              onCancelCreate={handleCancelCreate}
              createSaving={createSaving}
              onPickTemplate={handleNewFromTemplate}
              onNewBlank={handleNewBlank}
            />
          </div>

          {/* Right: progress / context */}
          <div className={crm.checklistSideCol}>
            <ChecklistProgressPanel checklist={selected} />
          </div>
        </div>
      </div>
    </div>
  );
}
