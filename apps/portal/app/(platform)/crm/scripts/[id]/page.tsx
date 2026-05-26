"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ArrowLeft, BadgeCheck, CalendarClock, FileText, Tag, Zap } from "lucide-react";
import { CRMEmptyState } from "../../../../../components/crm/CRMEmptyState";
import { CRMPageShell } from "../../../../../components/crm/CRMPageShell";
import { cn } from "../../../../../components/crm/cn";
import { crm } from "../../../../../components/crm/crmClasses";
import { ScriptEditModal } from "../../../../../components/crm/scripts/ScriptEditModal";
import { ScriptWorkspace } from "../../../../../components/crm/scripts/ScriptWorkspace";
import { parseScriptSections } from "../../../../../components/crm/scripts/ScriptTemplates";
import type { Script } from "../../../../../components/crm/scripts/scriptTypes";
import { apiGet, apiPatch, apiPost } from "../../../../../services/apiClient";

export default function CrmScriptDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const scriptId = params.id;
  const [script, setScript] = useState<Script | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  async function loadScript() {
    setLoading(true);
    setFetchError(null);
    try {
      const res = await apiGet<{ script: Script }>(`/crm/scripts/${scriptId}`);
      setScript(res.script);
    } catch (err: unknown) {
      setFetchError(String((err as Error)?.message ?? "Failed to load script"));
      setScript(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadScript();
  }, [scriptId]);

  async function handleSave(data: { name: string; body: string }) {
    const res = await apiPatch<{ script: Script }>(`/crm/scripts/${scriptId}`, data);
    setScript(res.script);
    setModalOpen(false);
  }

  async function handleArchive(id: string) {
    const res = await apiPatch<{ script: Script }>(`/crm/scripts/${id}`, { isActive: false });
    setScript(res.script);
  }

  async function handleRestore(id: string) {
    const res = await apiPatch<{ script: Script }>(`/crm/scripts/${id}`, { isActive: true });
    setScript(res.script);
  }

  async function handleDuplicate() {
    if (!script) return;
    const res = await apiPost<{ script: Script }>("/crm/scripts", {
      name: `${script.name} Copy`,
      body: script.body,
    });
    router.push(`/crm/scripts/${res.script.id}`);
  }

  return (
    <CRMPageShell innerClassName={cn(crm.pageInnerScripts, crm.scriptsWorkspace)}>
      <div className="flex flex-col gap-4">
        <Link href="/crm/scripts" className={cn(crm.btnGhost, "w-fit rounded-2xl text-sm")}>
          <ArrowLeft className="h-4 w-4" />
          Back to Scripts
        </Link>

        {loading ? (
          <div className={cn(crm.scriptsPanelPrimary, "min-h-[34rem] animate-pulse")} />
        ) : fetchError || !script ? (
          <CRMEmptyState
            title="Could not load script"
            description={fetchError ?? "The selected script was not found."}
            action={
              <button type="button" onClick={() => void loadScript()} className={crm.btnSecondary}>
                Retry
              </button>
            }
          />
        ) : (
          <div className="crm-script-detail-grid grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)] xl:gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,24rem)]">
            <ScriptWorkspace
              script={script}
              onEdit={() => setModalOpen(true)}
              onArchive={(id) => void handleArchive(id)}
              onRestore={(id) => void handleRestore(id)}
              onDuplicate={() => void handleDuplicate()}
            />
            <ScriptDetailRail script={script} />
          </div>
        )}
      </div>

      {modalOpen && script ? (
        <ScriptEditModal script={script} onSave={handleSave} onClose={() => setModalOpen(false)} />
      ) : null}
    </CRMPageShell>
  );
}

function ScriptDetailRail({ script }: { script: Script }) {
  const sections = parseScriptSections(script.body);
  const tags = [script.isActive ? "active" : "archived", "call script", "playbook"];

  return (
    <aside className="flex min-w-0 flex-col gap-3">
      <div className={crm.scriptsSidePanel}>
        <div className="mb-3 flex items-center gap-2">
          <span className="scripts-mini-icon scripts-mini-icon--blue">
            <BadgeCheck className="h-4 w-4" />
          </span>
          <p className="text-sm font-bold text-crm-text">Instructions</p>
        </div>
        <div className="scripts-instruction-card rounded-2xl px-3 py-3 text-sm text-crm-muted">
          Use this script as a guide during calls. Personalize your conversation and listen for cues.
        </div>
        <ol className="mt-3 flex flex-col gap-3">
          {[
            ["Personalize", "Tailor the opening to the prospect's business."],
            ["Listen & Ask", "Use open questions and capture context."],
            ["Focus on Value", "Connect the pitch to the desired outcome."],
            ["Confirm Next Step", "Always end with a clear next action."],
          ].map(([title, body], index) => (
            <li key={title} className="flex gap-3">
              <span className="scripts-step-badge">{index + 1}</span>
              <span>
                <span className="block text-xs font-bold text-crm-text">{title}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-crm-muted">{body}</span>
              </span>
            </li>
          ))}
        </ol>
      </div>

      <div className={cn(crm.scriptsSidePanel, "scripts-side-panel--tips")}>
        <div className="mb-3 flex items-center gap-2">
          <span className="scripts-mini-icon scripts-mini-icon--green">
            <Zap className="h-4 w-4" />
          </span>
          <p className="text-sm font-bold text-crm-text">Pro Tips</p>
        </div>
        <ul className="flex flex-col gap-2 text-xs text-crm-muted">
          {[
            "Keep it conversational, not robotic.",
            "Pause and listen more than you talk.",
            "Adapt the script based on the conversation.",
            "Track outcomes to continuously improve.",
          ].map((tip) => (
            <li key={tip} className="flex items-center gap-2">
              <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-crm-success" />
              <span>{tip}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className={crm.scriptsSidePanel}>
        <p className="mb-3 text-sm font-bold text-crm-text">Script Details</p>
        <div className="flex flex-col gap-2">
          <MetaRow icon={<FileText className="h-4 w-4" />} label="Sections" value={`${sections.length}`} />
          <MetaRow icon={<Tag className="h-4 w-4" />} label="Status" value={script.isActive ? "Active" : "Archived"} />
          <MetaRow
            icon={<CalendarClock className="h-4 w-4" />}
            label="Last Updated"
            value={new Date(script.updatedAt).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
          />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {tags.map((tag) => (
            <span key={tag} className="scripts-category-pill scripts-category-pill--blue">
              {tag}
            </span>
          ))}
        </div>
      </div>
    </aside>
  );
}

function MetaRow({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="scripts-workload-row flex items-center justify-between gap-3 rounded-2xl border px-3 py-2.5">
      <span className="flex items-center gap-2 text-xs text-crm-muted">
        {icon}
        {label}
      </span>
      <span className="text-xs font-bold text-crm-text">{value}</span>
    </div>
  );
}
