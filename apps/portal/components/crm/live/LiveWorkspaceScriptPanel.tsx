"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown, FileText } from "lucide-react";
import { apiGet } from "../../../services/apiClient";
import { CRMCard } from "../CRMCard";
import { crm } from "../crmClasses";
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
    <CRMCard padding="md">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="text-sm font-semibold text-crm-text">Call script</span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-crm-muted transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open ? (
        <div className="mt-3 space-y-3">
          {scriptSummaries.length === 0 ? (
            <p className="text-sm text-crm-muted">
              No active scripts.{" "}
              <Link href="/crm/scripts" className="text-crm-accent hover:underline">
                Create in Scripts
              </Link>
            </p>
          ) : (
            <select value={selectedId} onChange={(e) => handleSelect(e.target.value)} className={crm.input}>
              <option value="">— Select script —</option>
              {scriptSummaries.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
          {loading ? <p className="text-sm text-crm-muted">Loading…</p> : null}
          {!loading && script ? (
            <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-crm border border-crm-border bg-crm-surface-2/80 p-3 text-sm leading-relaxed text-crm-text">
              {script.body}
            </pre>
          ) : null}
        </div>
      ) : null}
    </CRMCard>
  );
}
