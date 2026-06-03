"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CRMPageShell } from "../../../../components/crm/CRMPageShell";
import {
  CRMWorkspaceShell,
  CRMWorkspaceChrome,
  CRMWorkspaceBody,
  CRMWorkspaceMain,
  CRMWorkspaceRightRail,
} from "../../../../components/crm/CRMWorkspaceShell";
import { CRMEmptyState } from "../../../../components/crm/CRMEmptyState";
import { crm } from "../../../../components/crm/crmClasses";
import { cn } from "../../../../components/crm/cn";
import {
  ScriptCommandHeader,
  type ScriptSortMode,
  type ScriptStatusFilter,
  type ScriptViewMode,
} from "../../../../components/crm/scripts/ScriptCommandHeader";
import { ScriptLibraryPanel } from "../../../../components/crm/scripts/ScriptLibraryPanel";
import { ScriptOperationalSidebar } from "../../../../components/crm/scripts/ScriptOperationalSidebar";
import { ScriptEditModal } from "../../../../components/crm/scripts/ScriptEditModal";
import { mergeScriptSummaries, requireSavedScript, toScriptSummary } from "../../../../components/crm/crmSaveHelpers";
import { apiGet, apiPost } from "../../../../services/apiClient";
import { PermissionGate } from "../../../../components/PermissionGate";
import type { Script, ScriptSummary } from "../../../../components/crm/scripts/scriptTypes";

const SCRIPT_VIEW_STORAGE_KEY = "crm-scripts-view-mode";

function isDraftScript(_script: ScriptSummary) {
  return false;
}

export default function CrmScriptsPage() {
  const router = useRouter();
  const [scripts, setScripts] = useState<ScriptSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [libraryResetToken, setLibraryResetToken] = useState(0);
  const [statusFilter, setStatusFilter] = useState<ScriptStatusFilter>("all");
  const [search, setSearch] = useState("");
  const [sortMode, setSortMode] = useState<ScriptSortMode>("updated");
  const [viewMode, setViewMode] = useState<ScriptViewMode>("card");

  async function loadList(options?: { silent?: boolean; mergeLocal?: ScriptSummary[] }) {
    if (!options?.silent) setLoading(true);
    try {
      const res = await apiGet<{ scripts: ScriptSummary[] }>("/crm/scripts?includeInactive=true");
      const fetched = res.scripts ?? [];
      if (options?.mergeLocal?.length) {
        setScripts(mergeScriptSummaries(options.mergeLocal, fetched));
      } else if (options?.silent) {
        setScripts((prev) => mergeScriptSummaries(prev, fetched));
      } else {
        setScripts(fetched);
      }
      setFetchError(null);
    } catch (err: unknown) {
      setFetchError(String((err as Error)?.message ?? "Failed to load scripts"));
    } finally {
      if (!options?.silent) setLoading(false);
    }
  }

  useEffect(() => {
    void loadList();
  }, []);

  useEffect(() => {
    const saved = window.localStorage.getItem(SCRIPT_VIEW_STORAGE_KEY);
    if (saved === "card" || saved === "list") setViewMode(saved);
  }, []);

  const handleViewModeChange = useCallback((mode: ScriptViewMode) => {
    setViewMode(mode);
    window.localStorage.setItem(SCRIPT_VIEW_STORAGE_KEY, mode);
  }, []);

  const openCreate = useCallback(() => {
    setModalOpen(true);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tgt = e.target as HTMLElement | null;
      if (!tgt) return;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tgt.tagName)) return;
      if (tgt.getAttribute("contenteditable") === "true") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        openCreate();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openCreate]);

  function closeModal() {
    setModalOpen(false);
  }

  async function handleSave(data: { name: string; body: string }) {
    const res = await apiPost<{ script: Script }>("/crm/scripts", data);
    const script = requireSavedScript(res);
    const summary = toScriptSummary(script);
    setScripts((prev) => mergeScriptSummaries([summary, ...prev], prev));
    setLibraryResetToken((token) => token + 1);
    closeModal();
    void loadList({ silent: true, mergeLocal: [summary] });
  }

  const activeCount = scripts.filter((s) => s.isActive).length;
  const draftCount = scripts.filter(isDraftScript).length;
  const archivedCount = scripts.filter((s) => !s.isActive).length;
  const filteredScripts = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return scripts
      .filter((script) => {
        if (statusFilter === "active") return script.isActive && !isDraftScript(script);
        if (statusFilter === "draft") return isDraftScript(script);
        if (statusFilter === "archived") return !script.isActive;
        return true;
      })
      .filter((script) => {
        if (!needle) return true;
        return script.name.toLowerCase().includes(needle);
      })
      .sort((a, b) => {
        if (sortMode === "name") return a.name.localeCompare(b.name);
        if (sortMode === "created") return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      });
  }, [scripts, search, sortMode, statusFilter]);

  return (
    <PermissionGate permission="can_view_crm_scripts" fallback={<div className="state-box">You do not have Scripts access.</div>}>
    <CRMPageShell className={crm.tasksWorkspace} innerClassName={crm.pageInnerTasks}>
      <CRMWorkspaceShell>
        {loading ? (
          <>
            <CRMWorkspaceChrome>
              <ScriptCommandHeader
                totalCount={0}
                activeCount={0}
                draftCount={0}
                archivedCount={0}
                statusFilter={statusFilter}
                onStatusFilterChange={setStatusFilter}
                search={search}
                onSearchChange={setSearch}
                sortMode={sortMode}
                onSortModeChange={setSortMode}
                viewMode={viewMode}
                onViewModeChange={handleViewModeChange}
                shownCount={0}
                onCreate={() => openCreate()}
              />
            </CRMWorkspaceChrome>
            <div className={crm.scriptsGrid}>
              <div className={cn(crm.scriptsLibraryCol, "gap-2.5")}>
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className={cn(crm.scriptsPanelSupport, "h-14 animate-pulse")} />
                ))}
              </div>
              <div className={cn(crm.scriptsSideCol, "gap-2.5")}>
                {[1, 2, 3].map((i) => (
                  <div key={i} className={cn(crm.scriptsSidePanel, "h-24 animate-pulse")} />
                ))}
              </div>
            </div>
          </>
        ) : fetchError ? (
          <>
            <CRMWorkspaceChrome>
              <ScriptCommandHeader
                totalCount={0}
                activeCount={0}
                draftCount={0}
                archivedCount={0}
                statusFilter={statusFilter}
                onStatusFilterChange={setStatusFilter}
                search={search}
                onSearchChange={setSearch}
                sortMode={sortMode}
                onSortModeChange={setSortMode}
                viewMode={viewMode}
                onViewModeChange={handleViewModeChange}
                shownCount={0}
                onCreate={() => openCreate()}
              />
            </CRMWorkspaceChrome>
            <CRMEmptyState
              title="Could not load scripts"
              description={fetchError}
              action={
                <button
                  type="button"
                  className={crm.btnSecondary}
                  onClick={() => {
                    setLoading(true);
                    setFetchError(null);
                    void loadList();
                  }}
                >
                  Retry
                </button>
              }
            />
          </>
        ) : (
          <>
            <CRMWorkspaceChrome>
              <ScriptCommandHeader
                totalCount={scripts.length}
                activeCount={activeCount}
                draftCount={draftCount}
                archivedCount={archivedCount}
                statusFilter={statusFilter}
                onStatusFilterChange={setStatusFilter}
                search={search}
                onSearchChange={setSearch}
                sortMode={sortMode}
                onSortModeChange={setSortMode}
                viewMode={viewMode}
                onViewModeChange={handleViewModeChange}
                shownCount={filteredScripts.length}
                onCreate={() => openCreate()}
              />
            </CRMWorkspaceChrome>

            <CRMWorkspaceBody split>
              <CRMWorkspaceMain className="min-h-0">
                <ScriptLibraryPanel
                  scripts={filteredScripts}
                  totalCount={scripts.length}
                  selectedId={null}
                  resetFiltersToken={libraryResetToken}
                  viewMode={viewMode}
                  activeFilter={statusFilter}
                  search={search}
                  onSelect={(id) => router.push(`/crm/scripts/${id}`)}
                  onCreate={() => openCreate()}
                />
              </CRMWorkspaceMain>

              <CRMWorkspaceRightRail>
                <ScriptOperationalSidebar scripts={scripts} />
              </CRMWorkspaceRightRail>
            </CRMWorkspaceBody>
          </>
        )}
      </CRMWorkspaceShell>

      {modalOpen ? (
        <ScriptEditModal
          script={null}
          onSave={handleSave}
          onClose={closeModal}
        />
      ) : null}
    </CRMPageShell>
    </PermissionGate>
  );
}
