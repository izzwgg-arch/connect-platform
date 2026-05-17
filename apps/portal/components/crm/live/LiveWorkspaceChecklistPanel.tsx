"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CheckCircle2, ChevronDown, ClipboardList, Square } from "lucide-react";
import { apiPost } from "../../../services/apiClient";
import { CRMCard } from "../CRMCard";
import { crm } from "../crmClasses";
import { cn } from "../cn";
import type { Checklist } from "./liveTypes";

export function LiveWorkspaceChecklistPanel({
  checklists,
  contactId,
  linkedId,
  defaultChecklistId,
  onSaved,
}: {
  checklists: Checklist[];
  contactId: string;
  linkedId: string | null;
  defaultChecklistId?: string | null;
  onSaved: () => void;
}) {
  const [selectedId, setSelectedId] = useState("");
  const [checklist, setChecklist] = useState<Checklist | null>(null);
  const [answers, setAnswers] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");
  const [open, setOpen] = useState(true);
  const didPrefill = useRef(false);

  function handleSelectChecklist(id: string) {
    setSelectedId(id);
    const found = checklists.find((c) => c.id === id) ?? null;
    setChecklist(found);
    if (found) {
      const initial: Record<string, boolean> = {};
      found.items.forEach((item) => {
        initial[item.id] = false;
      });
      setAnswers(initial);
    } else {
      setAnswers({});
    }
    setSavedMsg("");
  }

  useEffect(() => {
    if (didPrefill.current || !defaultChecklistId || checklists.length === 0) return;
    const match = checklists.find((c) => c.id === defaultChecklistId);
    if (match) {
      didPrefill.current = true;
      handleSelectChecklist(defaultChecklistId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultChecklistId, checklists]);

  async function saveResponse() {
    if (!checklist) return;
    setSaving(true);
    try {
      await apiPost(`/crm/checklists/${checklist.id}/respond`, {
        contactId,
        linkedId: linkedId ?? undefined,
        answers,
      });
      setSavedMsg("Saved");
      onSaved();
      setTimeout(() => setSavedMsg(""), 3000);
    } catch {
      setSavedMsg("Save failed");
    } finally {
      setSaving(false);
    }
  }

  const requiredItems = checklist?.items.filter((i) => i.required) ?? [];
  const allRequiredChecked = requiredItems.every((i) => answers[i.id]);
  const checkedCount = Object.values(answers).filter(Boolean).length;
  const totalCount = checklist?.items.length ?? 0;

  return (
    <CRMCard padding="md">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex items-center gap-2">
          <ClipboardList className="h-4 w-4 text-crm-accent" />
          <span className="text-sm font-semibold text-crm-text">Checklist</span>
          {checklist && totalCount > 0 ? (
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[0.625rem] font-bold",
                allRequiredChecked ? "bg-crm-success/15 text-crm-success" : "bg-crm-warning/15 text-crm-warning",
              )}
            >
              {checkedCount}/{totalCount}
            </span>
          ) : null}
        </div>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-crm-muted transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open ? (
        <div className="mt-3 space-y-3">
          {checklists.length === 0 ? (
            <p className="text-sm text-crm-muted">
              No active checklists.{" "}
              <Link href="/crm/checklists" className="text-crm-accent hover:underline">
                Create in Checklists
              </Link>
            </p>
          ) : (
            <select value={selectedId} onChange={(e) => handleSelectChecklist(e.target.value)} className={crm.input}>
              <option value="">— Select checklist —</option>
              {checklists.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          {checklist ? (
            <div className="space-y-2">
              {checklist.items.map((item) => {
                const checked = !!answers[item.id];
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setAnswers((prev) => ({ ...prev, [item.id]: !prev[item.id] }))}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-crm border px-2.5 py-2 text-left text-sm transition-colors",
                      checked
                        ? "border-crm-success/35 bg-crm-success/8 text-crm-muted line-through"
                        : "border-crm-border bg-crm-surface-2/50 text-crm-text",
                    )}
                  >
                    {checked ? (
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-crm-success" />
                    ) : (
                      <Square className="h-4 w-4 shrink-0 text-crm-muted" />
                    )}
                    <span className="flex-1">{item.label}</span>
                    {item.required && !checked ? (
                      <span className="text-[0.625rem] font-bold text-crm-warning">Required</span>
                    ) : null}
                  </button>
                );
              })}
              <div className="flex items-center justify-between gap-2 pt-1">
                {savedMsg ? (
                  <span
                    className={cn("text-xs", savedMsg === "Save failed" ? "text-crm-danger" : "text-crm-success")}
                  >
                    {savedMsg}
                  </span>
                ) : (
                  <span className="text-xs text-crm-muted">
                    {allRequiredChecked
                      ? "All required items done"
                      : `${requiredItems.filter((i) => !answers[i.id]).length} required left`}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => void saveResponse()}
                  disabled={saving}
                  className={cn(crm.btnPrimary, "text-xs")}
                >
                  {saving ? "Saving…" : "Save response"}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </CRMCard>
  );
}
