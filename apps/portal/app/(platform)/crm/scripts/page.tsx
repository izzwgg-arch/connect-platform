"use client";

import { useCallback, useEffect, useState } from "react";
import { CRMPageShell } from "../../../../components/crm/CRMPageShell";
import { CRMEmptyState } from "../../../../components/crm/CRMEmptyState";
import { crm } from "../../../../components/crm/crmClasses";
import { cn } from "../../../../components/crm/cn";
import { ScriptCommandHeader } from "../../../../components/crm/scripts/ScriptCommandHeader";
import { ScriptLibraryPanel } from "../../../../components/crm/scripts/ScriptLibraryPanel";
import { ScriptOperationalSidebar } from "../../../../components/crm/scripts/ScriptOperationalSidebar";
import { ScriptQuickTipsStrip } from "../../../../components/crm/scripts/ScriptQuickTipsStrip";
import { ScriptWorkspace } from "../../../../components/crm/scripts/ScriptWorkspace";
import { ScriptWorkspaceIdle } from "../../../../components/crm/scripts/ScriptWorkspaceIdle";
import { ScriptEditModal } from "../../../../components/crm/scripts/ScriptEditModal";
import { SCRIPT_TEMPLATES } from "../../../../components/crm/scripts/ScriptTemplates";
import { apiGet, apiPost, apiPatch } from "../../../../services/apiClient";
import type { Script, ScriptSummary } from "../../../../components/crm/scripts/scriptTypes";

export default function CrmScriptsPage() {
  const [scripts, setScripts] = useState<ScriptSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedScript, setSelectedScript] = useState<Script | null>(null);
  const [loadingScript, setLoadingScript] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Script | null>(null);
  const [templateBody, setTemplateBody] = useState<string | undefined>(undefined);

  async function loadList() {
    try {
      const res = await apiGet<{ scripts: ScriptSummary[] }>("/crm/scripts?includeInactive=true");
      setScripts(res.scripts ?? []);
    } catch (err: unknown) {
      setFetchError(String((err as Error)?.message ?? "Failed to load scripts"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadList();
  }, []);

  async function loadScript(id: string) {
    setSelectedId(id);
    setLoadingScript(true);
    try {
      const res = await apiGet<{ script: Script }>(`/crm/scripts/${id}`);
      setSelectedScript(res.script);
    } catch {
      setSelectedScript(null);
    } finally {
      setLoadingScript(false);
    }
  }

  const openCreate = useCallback((templateKey?: string) => {
    setEditTarget(null);
    if (templateKey) {
      const tpl = SCRIPT_TEMPLATES.find((t) => t.key === templateKey);
      setTemplateBody(tpl?.body);
    } else {
      setTemplateBody(undefined);
    }
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

  function openEdit() {
    if (!selectedScript) return;
    setEditTarget(selectedScript);
    setTemplateBody(undefined);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditTarget(null);
    setTemplateBody(undefined);
  }

  async function handleSave(data: { name: string; body: string }) {
    if (editTarget) {
      const res = await apiPatch<{ script: Script }>(`/crm/scripts/${editTarget.id}`, data);
      setScripts((prev) =>
        prev.map((s) =>
          s.id === res.script.id
            ? { ...s, name: res.script.name, updatedAt: res.script.updatedAt }
            : s,
        ),
      );
      setSelectedScript(res.script);
    } else {
      const res = await apiPost<{ script: Script }>("/crm/scripts", data);
      setScripts((prev) => [res.script, ...prev]);
      setSelectedId(res.script.id);
      setSelectedScript(res.script);
    }
    closeModal();
  }

  async function handleArchive(id: string) {
    await apiPatch(`/crm/scripts/${id}`, { isActive: false });
    setScripts((prev) => prev.map((s) => (s.id === id ? { ...s, isActive: false } : s)));
    if (selectedScript?.id === id) {
      setSelectedScript((s) => (s ? { ...s, isActive: false } : null));
    }
  }

  async function handleRestore(id: string) {
    await apiPatch(`/crm/scripts/${id}`, { isActive: true });
    setScripts((prev) => prev.map((s) => (s.id === id ? { ...s, isActive: true } : s)));
    if (selectedScript?.id === id) {
      setSelectedScript((s) => (s ? { ...s, isActive: true } : null));
    }
  }

  function scrollToTemplates() {
    document.getElementById("script-templates")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const activeCount = scripts.filter((s) => s.isActive).length;

  return (
    <CRMPageShell innerClassName={cn(crm.pageInnerScripts, crm.scriptsWorkspace)}>
      <>
        <ScriptCommandHeader totalCount={scripts.length} activeCount={activeCount} />

        {loading ? (
          <div className={crm.scriptsGrid}>
            <div className={cn(crm.scriptsLibraryCol, "gap-2.5")}>
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className={cn(crm.scriptsPanelSupport, "h-14 animate-pulse")} />
              ))}
            </div>
            <div className={cn(crm.scriptsWorkspaceCol)}>
              <div className={cn(crm.scriptsPanelPrimary, "min-h-[28rem] animate-pulse")} />
            </div>
            <div className={cn(crm.scriptsSideCol, "gap-2.5")}>
              {[1, 2, 3].map((i) => (
                <div key={i} className={cn(crm.scriptsSidePanel, "h-24 animate-pulse")} />
              ))}
            </div>
          </div>
        ) : fetchError ? (
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
        ) : (
          <>
            <div className={crm.scriptsGrid}>
              <ScriptLibraryPanel
                scripts={scripts}
                selectedId={selectedId}
                onSelect={loadScript}
                onCreate={() => openCreate()}
                onUseTemplate={(key) => openCreate(key)}
              />

              <div className={crm.scriptsWorkspaceCol}>
                {loadingScript ? (
                  <ScriptWorkspace
                    script={{
                      id: "",
                      name: "",
                      body: "",
                      isActive: true,
                      createdAt: "",
                      updatedAt: "",
                    }}
                    loading
                    onEdit={() => {}}
                    onArchive={() => {}}
                    onRestore={() => {}}
                  />
                ) : selectedScript ? (
                  <ScriptWorkspace
                    script={selectedScript}
                    onEdit={openEdit}
                    onArchive={(id) => void handleArchive(id)}
                    onRestore={(id) => void handleRestore(id)}
                  />
                ) : (
                  <ScriptWorkspaceIdle
                    onCreate={() => openCreate()}
                    onBrowseTemplates={scrollToTemplates}
                  />
                )}
              </div>

              <ScriptOperationalSidebar scripts={scripts} onCreate={() => openCreate()} />
            </div>

            <ScriptQuickTipsStrip />
          </>
        )}
      </>

      {modalOpen ? (
        <ScriptEditModal
          script={editTarget}
          templateBody={templateBody}
          onSave={handleSave}
          onClose={closeModal}
        />
      ) : null}
    </CRMPageShell>
  );
}
