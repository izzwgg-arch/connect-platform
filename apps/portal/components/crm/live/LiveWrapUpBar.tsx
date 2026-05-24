"use client";

import { KeyboardEvent } from "react";
import { cn } from "../cn";
import { crm } from "../crmClasses";

export function LiveWrapUpBar({
  visible,
  canSave,
  saving,
  isPowerMode,
  onSave,
  onSaveNext,
}: {
  visible: boolean;
  canSave: boolean;
  saving: boolean;
  isPowerMode: boolean;
  onSave: () => void;
  onSaveNext?: () => void;
}) {
  if (!visible) return null;
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-crm-border/70 bg-crm-bg/85 backdrop-blur-md">
      <div className="mx-auto w-full max-w-screen-2xl px-4 py-2 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[11px] text-crm-muted">
            <span className="hidden sm:inline">Wrap-up</span> Shortcuts:
            <span className="ml-2 rounded border border-crm-border bg-crm-surface-2 px-1 font-mono">Enter</span>
            <span className="ml-1">Save</span>
            {isPowerMode ? (
              <>
                <span className="ml-2 rounded border border-crm-border bg-crm-surface-2 px-1 font-mono">Shift+Enter</span>
                <span className="ml-1">Save + Next</span>
              </>
            ) : null}
            <span className="ml-2">· 1–6 set disposition</span>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              disabled={!canSave || saving}
              onClick={onSave}
              className={cn(crm.btnSecondary, "py-1.5 text-xs")}
            >
              {saving ? "Saving…" : "Save"}
            </button>
            {isPowerMode && onSaveNext ? (
              <button
                type="button"
                disabled={!canSave || saving}
                onClick={onSaveNext}
                className={cn(crm.btnPrimary, "py-1.5 text-xs")}
                title="Shift+Enter"
              >
                {saving ? "Saving…" : "Save + Next Call"}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
