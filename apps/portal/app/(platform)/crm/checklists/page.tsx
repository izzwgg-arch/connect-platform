"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import {
  formatCrmSaveError,
  mergeChecklistSummaries,
  normalizeChecklist,
  requireSavedChecklist,
} from "../../../../components/crm/crmSaveHelpers";
import { apiGet, apiPost, apiPatch } from "../../../../services/apiClient";
import { crm } from "../../../../components/crm/crmClasses";
import {
  ChecklistCommandHeader,
  type ChecklistSortMode,
  type ChecklistHeaderTab,
  type ChecklistViewMode,
} from "../../../../components/crm/checklists/ChecklistCommandHeader";
import { ChecklistWorkspace } from "../../../../components/crm/checklists/ChecklistWorkspace";
import { ChecklistProgressPanel } from "../../../../components/crm/checklists/ChecklistProgressPanel";
import { cn } from "../../../../components/crm/cn";
import { PermissionGate } from "../../../../components/PermissionGate";
import {
  CRMWorkspaceShell,
  CRMWorkspaceChrome,
  CRMWorkspaceBody,
  CRMWorkspaceMain,
  CRMWorkspaceScrollRegion,
  CRMWorkspaceRightRail,
} from "../../../../components/crm/CRMWorkspaceShell";
import { CRMPageShell } from "../../../../components/crm/CRMPageShell";

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
const CHECKLIST_VIEW_STORAGE_KEY = "crm-checklists-view-mode";

function isDraftChecklist(checklist: Checklist) {
  return checklist.isActive && checklist.items.length === 0;
}

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
  const [headerTab, setHeaderTab] = useState<ChecklistHeaderTab>("all");
  const [search, setSearch] = useState("");
  const [sortMode, setSortMode] = useState<ChecklistSortMode>("updated");
  const [viewMode, setViewMode] = useState<ChecklistViewMode>("card");

  // Create state
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createItems, setCreateItems] = useState<EditItem[]>([]);
  const [createSaving, setCreateSaving] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const activeChecklists = useMemo(
    () => checklists.filter((c) => c.isActive && !isDraftChecklist(c)),
    [checklists]
  );
  const draftCount = useMemo(
    () => checklists.filter(isDraftChecklist).length,
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

  const filteredChecklists = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return checklists
      .filter((checklist) => {
        if (headerTab === "active") return checklist.isActive && !isDraftChecklist(checklist);
        if (headerTab === "draft") return isDraftChecklist(checklist);
        if (headerTab === "archived") return !checklist.isActive;
        return true;
      })
      .filter((checklist) => {
        if (!needle) return true;
        return checklist.name.toLowerCase().includes(needle);
      })
      .sort((a, b) => {
        if (sortMode === "name") return a.name.localeCompare(b.name);
        if (sortMode === "steps") return b.items.length - a.items.length || a.name.localeCompare(b.name);
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      });
  }, [checklists, headerTab, search, sortMode]);

  async function loadList(options?: { silent?: boolean; mergeLocal?: Checklist[] }) {
    if (!options?.silent) setLoading(true);
    try {
      const res = await apiGet<{ checklists: Checklist[] }>(
        "/crm/checklists?includeInactive=true"
      );
      const fetched = (res.checklists ?? []).map((checklist) => normalizeChecklist(checklist));
      if (options?.mergeLocal?.length) {
        setChecklists(mergeChecklistSummaries(options.mergeLocal, fetched));
      } else if (options?.silent) {
        setChecklists((prev) => mergeChecklistSummaries(prev, fetched));
      } else {
        setChecklists(fetched);
      }
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

  useEffect(() => {
    const saved = window.localStorage.getItem(CHECKLIST_VIEW_STORAGE_KEY);
    if (saved === "card" || saved === "list") setViewMode(saved);
  }, []);

  const handleViewModeChange = useCallback((mode: ChecklistViewMode) => {
    setViewMode(mode);
    window.localStorage.setItem(CHECKLIST_VIEW_STORAGE_KEY, mode);
  }, []);

  function handleNewBlank() {
    setCreating(true);
    setSelected(null);
    setCreateName("");
    setCreateItems([{ label: "", required: false, sortOrder: 0 }]);
    setCreateError(null);
    setHeaderTab("all");
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
    setHeaderTab("all");
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
      setChecklists((prev) => mergeChecklistSummaries([checklist, ...prev], prev));
      setCreating(false);
      setSelected(checklist);
      setCreateName("");
      setCreateItems([]);
      setSavedMsg("Saved");
      setTimeout(() => setSavedMsg(""), 2500);
      void loadList({ silent: true, mergeLocal: [checklist] });
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
      setChecklists((prev) => mergeChecklistSummaries([checklist], prev));
      setSavedMsg("Saved");
      setTimeout(() => setSavedMsg(""), 2500);
      void loadList({ silent: true, mergeLocal: [checklist] });
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

  if (loading) {
    return (
      <PermissionGate permission="can_view_crm_checklists" fallback={<div className="state-box">You do not have Checklists access.</div>}>
      <CRMPageShell className={crm.tasksWorkspace} innerClassName={crm.pageInnerTasks}>
          <LoadingSkeleton />
      </CRMPageShell>
      </PermissionGate>
    );
  }

  return (
    <PermissionGate permission="can_view_crm_checklists" fallback={<div className="state-box">You do not have Checklists access.</div>}>
    <CRMPageShell className={crm.tasksWorkspace} innerClassName={crm.pageInnerTasks}>
      <span className="sr-only">CRM checklist command center</span>
        <CRMWorkspaceShell>
          <CRMWorkspaceChrome>
            <ChecklistCommandHeader
              activeCount={activeChecklists.length}
              archivedCount={archivedCount}
              draftCount={draftCount}
              totalCount={checklists.length}
              avgRequiredPct={avgRequiredPct}
              liveReadyCount={liveReadyCount}
              tab={headerTab}
              onTabChange={setHeaderTab}
              search={search}
              onSearchChange={setSearch}
              sortMode={sortMode}
              onSortModeChange={setSortMode}
              viewMode={viewMode}
              onViewModeChange={handleViewModeChange}
              shownCount={filteredChecklists.length}
              onNewBlank={handleNewBlank}
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
          </CRMWorkspaceChrome>

          <CRMWorkspaceBody split>
            <CRMWorkspaceMain>
              <CRMWorkspaceScrollRegion>
                <ChecklistWorkspace
                  selected={selected}
                  checklists={filteredChecklists}
                  totalCount={checklists.length}
                  viewMode={viewMode}
                  activeFilter={headerTab}
                  search={search}
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
                  onNewBlank={handleNewBlank}
                />
              </CRMWorkspaceScrollRegion>
            </CRMWorkspaceMain>

            <CRMWorkspaceRightRail>
              <ChecklistProgressPanel
                checklist={selected}
                checklists={checklists}
                avgRequiredPct={avgRequiredPct}
                liveReadyCount={liveReadyCount}
                onNewBlank={handleNewBlank}
              />
            </CRMWorkspaceRightRail>
          </CRMWorkspaceBody>
        </CRMWorkspaceShell>
    </CRMPageShell>
    </PermissionGate>
  );
}
