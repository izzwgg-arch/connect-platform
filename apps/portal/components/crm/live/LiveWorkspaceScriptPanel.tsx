"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown, FileText } from "lucide-react";
import { cn } from "../cn";
import { apiGet } from "../../../services/apiClient";
import { CRMCard } from "../CRMCard";
import { ConnectSelect } from "../../ConnectSelect";
import type { Script, ScriptSummary } from "./liveTypes";

export function LiveWorkspaceScriptPanel({
  scriptSummaries,
  defaultScriptId,
}: {
  scriptSummaries: ScriptSummary[];
  defaultScriptId?: string | null;
}) {
  const [selectedId, setSelectedId] = useState("");
  const [script, setScript] = useState<Script | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(true);
  const didPrefill = useRef(false);

  async function loadScript(id: string) {
    if (!id) {
      setScript(null);
      return;
    }
    setLoading(true);
    try {
      const res = await apiGet<{ script: Script }>(`/crm/scripts/${id}`);
      setScript(res.script);
    } catch {
      setScript(null);
    } finally {
      setLoading(false);
    }
  }

  function handleSelect(id: string) {
    setSelectedId(id);
    void loadScript(id);
  }

  useEffect(() => {
    if (didPrefill.current || !defaultScriptId || scriptSummaries.length === 0) return;
    const match = scriptSummaries.find((s) => s.id === defaultScriptId);
    if (match) {
      didPrefill.current = true;
      handleSelect(defaultScriptId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultScriptId, scriptSummaries]);

  return (
    <CRMCard padding="md" className="crm-contact-module-card crm-contact-script-panel">
      <button
        type="button"
        className="crm-contact-module-header flex w-full items-center justify-between gap-2 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="inline-flex min-w-0 items-center gap-2">
          <span className="crm-contact-module-icon-bubble"><FileText className="h-4 w-4" /></span>
          <span className="text-sm font-semibold text-crm-text">Call script</span>
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-crm-muted transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open ? (
        <div className="mt-3 space-y-3">
          {scriptSummaries.length === 0 ? (
            <p className="crm-contact-module-empty text-sm text-crm-muted">
              No active scripts.{" "}
              <Link href="/crm/scripts" className="text-crm-accent hover:underline">
                Create in Scripts
              </Link>
            </p>
          ) : (
            <ConnectSelect
              value={selectedId}
              onChange={(value) => handleSelect(value)}
              className="w-full"
              placeholder="— Select script —"
              options={scriptSummaries.map((s) => ({ value: s.id, label: `${s.name}${s.id === defaultScriptId ? " · Default" : ""}` }))}
            />
          )}
          {loading ? <p className="crm-contact-module-empty text-sm text-crm-muted">Loading…</p> : null}
          {!loading && script ? (
            <pre className={cn("crm-contact-script-reader max-h-72 overflow-y-auto whitespace-pre-wrap rounded-crm border border-crm-border bg-crm-surface-2/80 p-3 text-sm leading-relaxed text-crm-text")}>
              {script.body}
            </pre>
          ) : null}
        </div>
      ) : null}
    </CRMCard>
  );
}
