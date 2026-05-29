"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { formatCrmSaveError, normalizeChecklist, requireSavedChecklist } from "../../../../components/crm/crmSaveHelpers";
import { apiGet, apiPost, apiPatch } from "../../../../services/apiClient";
import { crm } from "../../../../components/crm/crmClasses";
import {
  ChecklistCommandHeader,
  type ChecklistHeaderTab,
} from "../../../../components/crm/checklists/ChecklistCommandHeader";
import { ChecklistWorkspace } from "../../../../components/crm/checklists/ChecklistWorkspace";
import { ChecklistProgressPanel } from "../../../../components/crm/checklists/ChecklistProgressPanel";
import { ChecklistQuickTipsStrip } from "../../../../components/crm/checklists/ChecklistQuickTipsStrip";
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

function isLiveReady(c: Checklist) {
  return c.isActive && c.items.length > 0 && c.items.some((i) => i.required);
}

function requiredRatio(c: Checklist) {
  if (c.items.length === 0) return 0;
  return Math.round(
    (c.items.filter((i) => i.required).length / c.items.length) * 100
  );
}

export default function CrmChecklistsPage() {
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Checklist | null>(null);
  const [savedMsg, setSavedMsg] = useState("");
  const [headerTab, setHeaderTab] = useState<ChecklistHeaderTab>("active");

  // Create state
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createItems, setCreateItems] = useState<EditItem[]>([]);
  const [createSaving, setCreateSaving] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const activeChecklists = useMemo(
    () => checklists.filter((c) => c.isActive),
    [checklists]
  );
  const archivedCount = useMemo(
    () => checklists.filter((c) => !c.isActive).length,
    [checklists]
  );
  const liveReadyCount = useMemo(
    () => activeChecklists.filter(isLiveReady).length,
    [activeChecklists]
  );
  const avgRequiredPct = useMemo(() => {
    if (activeChecklists.length === 0) return 0;
    const sum = activeChecklists.reduce((acc, c) => acc + requiredRatio(c), 0);
    return Math.round(sum / activeChecklists.length);
  }, [activeChecklists]);

  async function loadList(options?: { silent?: boolean }) {
    if (!options?.silent) setLoading(true);
    try {
      const res = await apiGet<{ checklists: Checklist[] }>(
        "/crm/checklists?includeInactive=true"
      );
      setChecklists((res.checklists ?? []).map((checklist) => normalizeChecklist(checklist)));
      setError(null);
    } catch (err: unknown) {
      setError(String((err as Error)?.message ?? "Failed to load checklists"));
    } finally {
      if (!options?.silent) setLoading(false);
    }
  }

  useEffect(() => {
    loadList();
  }, []);

  function handleNewBlank() {
    setCreating(true);
    setSelected(null);
    setCreateName("");
    setCreateItems([{ label: "", required: false, sortOrder: 0 }]);
    setCreateError(null);
    setHeaderTab("active");
  }

  function handleBrowseTemplates() {
    setSelected(null);
    setCreating(false);
    setHeaderTab("templates");
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tgt = e.target as HTMLElement | null;
      if (!tgt) return;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tgt.tagName)) return;
      if (tgt.getAttribute("contenteditable") === "true") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() !== "n") return;
      e.preventDefault();
      handleNewBlank();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function handleSelect(id: string) {
    const found = checklists.find((c) => c.id === id) ?? null;
    setSelected(found);
    setCreating(false);
    setHeaderTab("active");
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
    setCreateError(null);
    setHeaderTab("active");
  }

  const handleConfirmCreate = useCallback(async () => {
    if (!createName.trim()) return;
    setCreateSaving(true);
    setCreateError(null);
    try {
      const validItems = createItems
        .filter((i) => i.label.trim())
        .map((i, idx) => ({ ...i, sortOrder: idx }));
      const res = await apiPost<{ checklist: Checklist }>("/crm/checklists", {
        name: createName.trim(),
        items: validItems,
      });
      const checklist = normalizeChecklist(requireSavedChecklist(res));
      await loadList({ silent: true });
      setCreating(false);
      setSelected(checklist);
      setCreateName("");
      setCreateItems([]);
    } catch (err: unknown) {
      setCreateError(formatCrmSaveError(err));
    } finally {
      setCreateSaving(false);
    }
  }, [createName, createItems]);

  const handleCancelCreate = useCallback(() => {
    setCreating(false);
    setCreateName("");
    setCreateItems([]);
    setCreateError(null);
  }, []);

  const handleSaveEdit = useCallback(
    async (name: string, items: EditItem[]) => {
      if (!selected) throw new Error("No checklist selected.");
      const res = await apiPatch<{ checklist: Checklist }>(
        `/crm/checklists/${selected.id}`,
        { name, items }
      );
      const checklist = normalizeChecklist(requireSavedChecklist(res));
      setSelected(checklist);
      setChecklists((prev) =>
        prev.map((c) => (c.id === checklist.id ? checklist : c))
      );
      await loadList({ silent: true });
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

  const templatesFocus = headerTab === "templates";
  const progressHighlight = headerTab === "progress";

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
      <span className="sr-only">CRM checklist command center</span>
      <div className={crm.checklistAmbientLayer} aria-hidden>
        <span className="checklist-ambient-orb left-[-8%] top-[8%] h-64 w-64 bg-crm-accent/10" />
        <span className="checklist-ambient-orb right-[-5%] top-[35%] h-48 w-48 bg-indigo-500/8" />
        <span className="checklist-ambient-orb bottom-[5%] left-[30%] h-56 w-56 bg-crm-accent/6" />
      </div>
      <div className={cn(crm.pageInnerChecklist, "gap-3")}>
        <ChecklistCommandHeader
          activeCount={activeChecklists.length}
          archivedCount={archivedCount}
          avgRequiredPct={avgRequiredPct}
          liveReadyCount={liveReadyCount}
          tab={headerTab}
          onTabChange={setHeaderTab}
          onNewBlank={handleNewBlank}
          onBrowseTemplates={handleBrowseTemplates}
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

        <div className={crm.checklistGrid}>
          <div className={crm.checklistMainCol}>
            <ChecklistWorkspace
              selected={selected}
              checklists={checklists}
              onSelect={handleSelect}
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
              createError={createError}
              onPickTemplate={handleNewFromTemplate}
              onNewBlank={handleNewBlank}
              templatesFocus={templatesFocus}
            />
          </div>

          <div
            className={cn(
              crm.checklistRailCol,
              progressHighlight &&
                "rounded-crm-lg ring-1 ring-crm-accent/25 transition-shadow"
            )}
          >
            <ChecklistProgressPanel
              checklist={selected}
              checklists={checklists}
              avgRequiredPct={avgRequiredPct}
              liveReadyCount={liveReadyCount}
              onNewBlank={handleNewBlank}
              onBrowseTemplates={handleBrowseTemplates}
            />
          </div>
        </div>

        <ChecklistQuickTipsStrip
          onNewBlank={handleNewBlank}
          onBrowseTemplates={handleBrowseTemplates}
        />
      </div>
    </div>
  );
}
