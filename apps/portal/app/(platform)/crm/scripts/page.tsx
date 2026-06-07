"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CRMPageShell } from "../../../../components/crm/CRMPageShell";
import {
  CRMWorkspaceShell,
  CRMWorkspaceChrome,
  CRMWorkspaceBody,
  CRMWorkspaceMain,
  CRMWorkspaceScrollRegion,
  CRMWorkspaceRightRail,
} from "../../../../components/crm/CRMWorkspaceShell";
import { CRMEmptyState } from "../../../../components/crm/CRMEmptyState";
import { crm } from "../../../../components/crm/crmClasses";
import { cn } from "../../../../components/crm/cn";
import {
  ScriptCommandHeader,
  type ScriptSortMode,
  type ScriptStatusFilter,
} from "../../../../components/crm/scripts/ScriptCommandHeader";
import { ScriptLibraryPanel } from "../../../../components/crm/scripts/ScriptLibraryPanel";
import { ScriptOperationalSidebar } from "../../../../components/crm/scripts/ScriptOperationalSidebar";
import { mergeScriptSummaries, requireSavedScript, toScriptSummary } from "../../../../components/crm/crmSaveHelpers";
import { apiDelete, apiGet, apiPatch, apiPost } from "../../../../services/apiClient";
import { PermissionGate } from "../../../../components/PermissionGate";
import type { Script, ScriptSummary } from "../../../../components/crm/scripts/scriptTypes";

function isDraftScript(_script: ScriptSummary) {
  return false;
}

type ScriptPreviewSummary = ScriptSummary & {
  body?: string;
  previewOnly?: boolean;
};

const DEV_SCRIPT_PREVIEW_COUNT = 22;

const DEV_SCRIPT_ROWS: Script[] = [
  {
    id: "dev-script-side-panel-qa",
    name: "Side Panel QA Script",
    isActive: true,
    createdAt: "2026-05-20T14:00:00.000Z",
    updatedAt: "2026-06-05T19:30:00.000Z",
    body: "## Opener\nConfirm the contact, company, and reason for the call.\n\n## Discovery\nAsk what changed recently and what outcome they want from the next step.\n\n## Close\nConfirm the best callback number and summarize the agreed next action.",
  },
  {
    id: "dev-script-live-call-opening",
    name: "Live Call Opening Script",
    isActive: true,
    createdAt: "2026-05-21T14:00:00.000Z",
    updatedAt: "2026-06-05T18:20:00.000Z",
    body: "## Greeting\nHi [First name], this is [Agent] with Connect.\n\n## Reason\nI am calling about your recent request and want to make sure we have the right details.\n\n## Transition\nDo you have two minutes to confirm the next step?",
  },
  {
    id: "dev-script-campaign-launch",
    name: "Campaign Launch Talk Track",
    isActive: true,
    createdAt: "2026-05-22T14:00:00.000Z",
    updatedAt: "2026-06-05T17:40:00.000Z",
    body: "## Context\nReference the campaign offer and the customer's submitted interest.\n\n## Qualify\nConfirm timing, decision maker, and preferred communication channel.\n\n## Wrap\nOffer the next appointment slot and send a recap.",
  },
  {
    id: "dev-script-archived",
    name: "Archived Legacy Pitch",
    isActive: false,
    createdAt: "2026-05-18T14:00:00.000Z",
    updatedAt: "2026-06-04T20:15:00.000Z",
    body: "## Legacy Intro\nThis archived script is retained for review only.\n\n## Notes\nUse the active replacement instead.",
  },
];

function cloneScriptForDevPreview(script: Script, index: number): ScriptPreviewSummary {
  const cloneNumber = index + 1;
  return {
    ...script,
    id: `${script.id}-preview-${cloneNumber}`,
    name: `${script.name} ${cloneNumber}`,
    updatedAt: new Date(
      new Date(script.updatedAt).getTime() - cloneNumber * 11 * 60_000
    ).toISOString(),
    previewOnly: true,
  };
}

function expandScriptsForDevPreview(rows: ScriptSummary[]): ScriptPreviewSummary[] {
  if (process.env.NODE_ENV !== "development") return rows;
  const source =
    rows.length === 0 || rows.length < DEV_SCRIPT_PREVIEW_COUNT
      ? [...DEV_SCRIPT_ROWS.map((script) => ({ ...script, previewOnly: true })), ...rows]
      : rows;
  if (source.length >= DEV_SCRIPT_PREVIEW_COUNT) return source;
  const clonesNeeded = DEV_SCRIPT_PREVIEW_COUNT - source.length;
  const clones = Array.from({ length: clonesNeeded }, (_, index) =>
    cloneScriptForDevPreview(DEV_SCRIPT_ROWS[index % DEV_SCRIPT_ROWS.length], index)
  );
  return [...source, ...clones];
}

export default function CrmScriptsPage() {
  const [scripts, setScripts] = useState<ScriptSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [selectedScript, setSelectedScript] = useState<Script | null>(null);
  const [selectedLoading, setSelectedLoading] = useState(false);
  const [selectedError, setSelectedError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");
  const [defaultScriptId, setDefaultScriptId] = useState<string | null>(null);
  const [libraryResetToken, setLibraryResetToken] = useState(0);
  const [statusFilter, setStatusFilter] = useState<ScriptStatusFilter>("all");
  const [search, setSearch] = useState("");
  const [sortMode, setSortMode] = useState<ScriptSortMode>("updated");
  const sourceScripts = useMemo(() => expandScriptsForDevPreview(scripts), [scripts]);

  async function loadList(options?: { silent?: boolean; mergeLocal?: ScriptSummary[] }) {
    if (!options?.silent) setLoading(true);
    try {
      const res = await apiGet<{ scripts: ScriptSummary[]; defaultScriptId?: string | null }>("/crm/scripts?includeInactive=true");
      const fetched = res.scripts ?? [];
      setDefaultScriptId(res.defaultScriptId ?? null);
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

  const openCreate = useCallback(() => {
    setCreating(true);
    setSelectedScript(null);
    setSelectedError(null);
    setStatusFilter("all");
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

  function flashSaved(message = "Saved") {
    setSavedMsg(message);
    window.setTimeout(() => setSavedMsg(""), 2500);
  }

  async function handleSelect(id: string) {
    setCreating(false);
    setSelectedLoading(true);
    setSelectedError(null);
    const summary = sourceScripts.find((script) => script.id === id) ?? null;
    if (summary) {
      setSelectedScript((prev) =>
        prev?.id === id ? prev : { ...summary, body: "" }
      );
    }
    if (summary?.previewOnly) {
      setSelectedScript({
        id: summary.id,
        name: summary.name,
        isActive: summary.isActive,
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
        body: summary.body ?? "",
      });
      setSelectedLoading(false);
      return;
    }
    try {
      const res = await apiGet<{ script: Script }>(`/crm/scripts/${id}`);
      setSelectedScript(res.script);
    } catch (err: unknown) {
      setSelectedError(String((err as Error)?.message ?? "Failed to load script"));
      setSelectedScript(null);
    } finally {
      setSelectedLoading(false);
    }
  }

  async function handleCreate(data: { name: string; body: string }) {
    const res = await apiPost<{ script: Script }>("/crm/scripts", data);
    const script = requireSavedScript(res);
    const summary = toScriptSummary(script);
    setScripts((prev) => mergeScriptSummaries([summary, ...prev], prev));
    setLibraryResetToken((token) => token + 1);
    setCreating(false);
    setSelectedScript(script);
    flashSaved("Created");
    void loadList({ silent: true, mergeLocal: [summary] });
  }

  const handleSaveEdit = useCallback(
    async (data: { name: string; body: string }) => {
      if (!selectedScript) throw new Error("No script selected.");
      if (selectedScript.id.startsWith("dev-script-")) {
        throw new Error("Preview scripts are read-only. Create a real script to save changes.");
      }
      const res = await apiPatch<{ script: Script }>(`/crm/scripts/${selectedScript.id}`, data);
      const script = requireSavedScript(res);
      const summary = toScriptSummary(script);
      setSelectedScript(script);
      setScripts((prev) => mergeScriptSummaries([summary], prev));
      flashSaved("Saved");
      void loadList({ silent: true, mergeLocal: [summary] });
    },
    [selectedScript],
  );

  async function handleArchive(id: string) {
    if (id.startsWith("dev-script-")) return;
    const res = await apiPatch<{ script: Script }>(`/crm/scripts/${id}`, { isActive: false });
    const script = requireSavedScript(res);
    const summary = toScriptSummary(script);
    if (defaultScriptId === id) setDefaultScriptId(null);
    setScripts((prev) => mergeScriptSummaries([summary], prev));
    setSelectedScript((current) => (current?.id === id ? script : current));
  }

  async function handleRestore(id: string) {
    if (id.startsWith("dev-script-")) return;
    const res = await apiPatch<{ script: Script }>(`/crm/scripts/${id}`, { isActive: true });
    const script = requireSavedScript(res);
    const summary = toScriptSummary(script);
    setScripts((prev) => mergeScriptSummaries([summary], prev));
    setSelectedScript((current) => (current?.id === id ? script : current));
  }

  async function handleDelete(id: string) {
    const targetName =
      selectedScript?.id === id
        ? selectedScript.name
        : sourceScripts.find((script) => script.id === id)?.name ?? "this script";
    if (!window.confirm(`Delete "${targetName}"? This archives it from the script list.`)) return;

    if (id.startsWith("dev-script-")) {
      setSelectedScript(null);
      setCreating(false);
      flashSaved("Deleted");
      return;
    }

    await apiDelete(`/crm/scripts/${id}`);
    if (defaultScriptId === id) setDefaultScriptId(null);
    setScripts((prev) => prev.filter((script) => script.id !== id));
    if (selectedScript?.id === id) setSelectedScript(null);
    setCreating(false);
    flashSaved("Deleted");
  }

  const activeCount = sourceScripts.filter((s) => s.isActive).length;
  const draftCount = sourceScripts.filter(isDraftScript).length;
  const archivedCount = sourceScripts.filter((s) => !s.isActive).length;
  const scriptsWithDefault = useMemo(
    () => sourceScripts.map((script) => ({ ...script, isDefault: script.id === defaultScriptId })),
    [sourceScripts, defaultScriptId],
  );

  const selectedScriptWithDefault = selectedScript
    ? { ...selectedScript, isDefault: selectedScript.id === defaultScriptId }
    : null;

  async function handleSetDefault(id: string) {
    if (id.startsWith("dev-script-")) return;
    const res = await apiPatch<{ script: Script }>(`/crm/scripts/${id}`, { isDefault: true });
    const script = requireSavedScript(res);
    const summary = toScriptSummary(script);
    setDefaultScriptId(id);
    setScripts((prev) => mergeScriptSummaries([{ ...summary, isDefault: true }], prev).map((item) => ({ ...item, isDefault: item.id === id })));
    setSelectedScript((current) => current?.id === id ? { ...script, isDefault: true } : current);
    flashSaved("Default set");
  }

  const filteredScripts = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return scriptsWithDefault
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
  }, [scriptsWithDefault, search, sortMode, statusFilter]);

  return (
    <PermissionGate permission="can_view_crm_scripts" fallback={<div className="state-box">You do not have Scripts access.</div>}>
    <CRMPageShell
      className={cn(crm.queueWorkspace, crm.scriptsWorkspace)}
      innerClassName={cn(crm.pageInnerScripts, "crm-scripts-inner")}
    >
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
                totalCount={scriptsWithDefault.length}
                activeCount={activeCount}
                draftCount={draftCount}
                archivedCount={archivedCount}
                statusFilter={statusFilter}
                onStatusFilterChange={setStatusFilter}
                search={search}
                onSearchChange={setSearch}
                sortMode={sortMode}
                onSortModeChange={setSortMode}
                shownCount={filteredScripts.length}
                onCreate={() => openCreate()}
              />
            </CRMWorkspaceChrome>

            <CRMWorkspaceBody split>
              <CRMWorkspaceMain className="crm-queue-main-workspace min-h-0">
                <CRMWorkspaceScrollRegion className="crm-queue-center-workspace">
                  <ScriptLibraryPanel
                    scripts={filteredScripts}
                    totalCount={scriptsWithDefault.length}
                    selectedId={creating ? null : selectedScriptWithDefault?.id ?? null}
                    resetFiltersToken={libraryResetToken}
                    activeFilter={statusFilter}
                    search={search}
                    onSelect={(id) => void handleSelect(id)}
                    onCreate={() => openCreate()}
                  />
                </CRMWorkspaceScrollRegion>
              </CRMWorkspaceMain>

              <CRMWorkspaceRightRail className="crm-queue-right-rail crm-queue-detail-rail flex flex-col min-h-0">
                <ScriptOperationalSidebar
                  script={selectedScriptWithDefault}
                  loading={selectedLoading}
                  error={selectedError}
                  creating={creating}
                  savedMsg={savedMsg}
                  onCreate={() => openCreate()}
                  onSaveCreate={handleCreate}
                  onCancelCreate={() => setCreating(false)}
                  onSaveEdit={handleSaveEdit}
                  onSetDefault={(id) => void handleSetDefault(id)}
                  onArchive={(id) => void handleArchive(id)}
                  onRestore={(id) => void handleRestore(id)}
                  onDelete={(id) => void handleDelete(id)}
                />
              </CRMWorkspaceRightRail>
            </CRMWorkspaceBody>
          </>
        )}
      </CRMWorkspaceShell>
    </CRMPageShell>
    </PermissionGate>
  );
}
