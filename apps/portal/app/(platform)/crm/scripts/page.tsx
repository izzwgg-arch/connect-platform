"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CRMPageShell } from "../../../../components/crm/CRMPageShell";
import { CRMEmptyState } from "../../../../components/crm/CRMEmptyState";
import { crm } from "../../../../components/crm/crmClasses";
import { cn } from "../../../../components/crm/cn";
import { ScriptCommandHeader } from "../../../../components/crm/scripts/ScriptCommandHeader";
import { ScriptLibraryPanel } from "../../../../components/crm/scripts/ScriptLibraryPanel";
import { ScriptOperationalSidebar } from "../../../../components/crm/scripts/ScriptOperationalSidebar";
import { ScriptQuickTipsStrip } from "../../../../components/crm/scripts/ScriptQuickTipsStrip";
import { ScriptEditModal } from "../../../../components/crm/scripts/ScriptEditModal";
import { SCRIPT_TEMPLATES } from "../../../../components/crm/scripts/ScriptTemplates";
import { apiGet, apiPost } from "../../../../services/apiClient";
import type { Script, ScriptSummary } from "../../../../components/crm/scripts/scriptTypes";

export default function CrmScriptsPage() {
  const router = useRouter();
  const [scripts, setScripts] = useState<ScriptSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
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

  const openCreate = useCallback((templateKey?: string) => {
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

  function closeModal() {
    setModalOpen(false);
    setTemplateBody(undefined);
  }

  async function handleSave(data: { name: string; body: string }) {
    const res = await apiPost<{ script: Script }>("/crm/scripts", data);
    setScripts((prev) => [res.script, ...prev]);
    closeModal();
    router.push(`/crm/scripts/${res.script.id}`);
  }

  function scrollToTemplates() {
    document.getElementById("script-templates")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const activeCount = scripts.filter((s) => s.isActive).length;

  return (
    <CRMPageShell innerClassName={cn(crm.pageInnerScripts, crm.scriptsWorkspace)}>
      <>
        <ScriptCommandHeader totalCount={scripts.length} activeCount={activeCount} onCreate={() => openCreate()} />

        {loading ? (
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
                selectedId={null}
                onSelect={(id) => router.push(`/crm/scripts/${id}`)}
                onCreate={() => openCreate()}
                onUseTemplate={(key) => openCreate(key)}
              />

              <ScriptOperationalSidebar scripts={scripts} onCreate={() => openCreate()} onBrowseTemplates={scrollToTemplates} />
            </div>

            <ScriptQuickTipsStrip />
          </>
        )}
      </>

      {modalOpen ? (
        <ScriptEditModal
          script={null}
          templateBody={templateBody}
          onSave={handleSave}
          onClose={closeModal}
        />
      ) : null}
    </CRMPageShell>
  );
}
