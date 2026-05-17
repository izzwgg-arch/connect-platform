"use client";

import { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import { CRMPageHeader } from "../../../../components/crm/CRMPageHeader";
import { CRMPageShell } from "../../../../components/crm/CRMPageShell";
import { CRMEmptyState } from "../../../../components/crm/CRMEmptyState";
import { crm } from "../../../../components/crm/crmClasses";
import { cn } from "../../../../components/crm/cn";
import { ScriptLibraryPanel } from "../../../../components/crm/scripts/ScriptLibraryPanel";
import { ScriptWorkspace } from "../../../../components/crm/scripts/ScriptWorkspace";
import { ScriptEditModal } from "../../../../components/crm/scripts/ScriptEditModal";
import { SCRIPT_TEMPLATES } from "../../../../components/crm/scripts/ScriptTemplates";
import { apiGet, apiPost, apiPatch } from "../../../../services/apiClient";
import type { Script, ScriptSummary } from "../../../../components/crm/scripts/scriptTypes";

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CrmScriptsPage() {
  const [scripts, setScripts] = useState<ScriptSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedScript, setSelectedScript] = useState<Script | null>(null);
  const [loadingScript, setLoadingScript] = useState(false);

  // Modal state
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

  function openCreate(templateKey?: string) {
    setEditTarget(null);
    if (templateKey) {
      const tpl = SCRIPT_TEMPLATES.find((t) => t.key === templateKey);
      setTemplateBody(tpl?.body);
    } else {
      setTemplateBody(undefined);
    }
    setModalOpen(true);
  }

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
      // Edit existing
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
      // Create new
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

  return (
    <CRMPageShell>
      <div className={cn(crm.pageInnerScripts, crm.scriptsWorkspace)}>
        {/* Page header */}
        <CRMPageHeader
          icon={<FileText className="h-5 w-5" />}
          title="Call Scripts"
          subtitle="Sales playbooks and cold-call scripts for your outbound team."
          actions={null}
        />

        {/* Loading */}
        {loading ? (
          <div className={crm.scriptsGrid}>
            <div className={cn(crm.scriptsLibraryCol, "gap-2.5")}>
              {[1, 2, 3].map((i) => (
                <div key={i} className={cn(crm.card, "h-12 animate-pulse")} />
              ))}
            </div>
            <div className={cn(crm.scriptsWorkspaceCol, "gap-3")}>
              <div className={cn(crm.card, crm.cardPad, "h-24 animate-pulse")} />
              <div className={cn(crm.card, crm.cardPad, "h-40 animate-pulse")} />
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
                onClick={() => { setLoading(true); setFetchError(null); void loadList(); }}
              >
                Retry
              </button>
            }
          />
        ) : (
          <div className={crm.scriptsGrid}>
            {/* Left: Library panel */}
            <ScriptLibraryPanel
              scripts={scripts}
              selectedId={selectedId}
              onSelect={loadScript}
              onCreate={() => openCreate()}
              onUseTemplate={(key) => openCreate(key)}
            />

            {/* Right: Workspace */}
            <div className={crm.scriptsWorkspaceCol}>
              {loadingScript ? (
                <ScriptWorkspace
                  script={{ id: "", name: "", body: "", isActive: true, createdAt: "", updatedAt: "" }}
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
                /* Nothing selected */
                <CRMEmptyState
                  title="Select a script"
                  description="Choose a script from the library to view it as a live playbook, or create a new one."
                  action={
                    <button
                      type="button"
                      className={crm.btnPrimary}
                      onClick={() => openCreate()}
                    >
                      New script
                    </button>
                  }
                />
              )}
            </div>
          </div>
        )}
      </div>

      {/* Edit / create modal */}
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
